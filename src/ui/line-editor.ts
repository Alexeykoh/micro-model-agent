import * as readline from "readline";
import stringWidth from "string-width";
import {
	buildLayout,
	layoutIndexFor,
	visualColAt,
	charOffsetFor,
	charLen,
	stripAnsi,
	type LayoutRow,
} from "./line-math";

export interface LineInput {
	setPrompt(prompt: string): void;
	prompt(preserveCursor?: boolean): void;
	write(s: string): void;
	question(query: string, cb: (answer: string) => void): void;
	close(): void;
	on(event: "line", listener: (line: string) => void): this;
	on(event: "close", listener: () => void): this;
}

export interface LineEditorOptions {
	input: NodeJS.ReadableStream & {
		isTTY?: boolean;
		setRawMode?: (mode: boolean) => void;
	};
	output: NodeJS.WritableStream & { columns?: number };
	prompt?: string;
	completer?: (line: string) => [string[], string];
	history?: string[];
	historySize?: number;
	tabSize?: number;
}

interface EditorListeners {
	line?: (line: string) => void;
	close?: () => void;
}

export class LineEditor implements LineInput {
	input: LineEditorOptions["input"];
	output: LineEditorOptions["output"];

	/** Host hook: return true to swallow the key before the editor handles it. */
	onKeyInput?: (str: string, key: unknown) => boolean;

	private promptStr: string;
	private completer?: (line: string) => [string[], string];
	private history: string[];
	private historySize: number;
	private lines: string[] = [""];
	private row = 0;
	private col = 0;
	private historyIndex = -1;
	private stash: { lines: string[]; row: number; col: number } | null = null;
	private isDone = false;
	private isPaste = false;
	private lastWasCR = false;
	private questionCb: ((answer: string) => void) | null = null;
	private rawMode = false;
	private listeners: EditorListeners = {};

	constructor(opts: LineEditorOptions) {
		this.input = opts.input;
		this.output = opts.output;
		this.promptStr = opts.prompt ?? "";
		this.completer = opts.completer;
		this.history = opts.history ?? [];
		this.historySize = opts.historySize ?? 50;
		if (this.history.length > this.historySize) {
			this.history = this.history.slice(-this.historySize);
		}

		if (this.input.isTTY) {
			this.rawMode = typeof this.input.setRawMode === "function";
			if (this.rawMode) this.input.setRawMode!(true);
			this.enableTerminalProtocols();
			readline.emitKeypressEvents(this.input as never);
			(this.input as any).on("keypress", (str: string, key: unknown) =>
				this.onKey(str, key),
			);
		} else {
			(this.input as any).on("data", (buf: Buffer) => this.onData(buf));
			(this.input as any).on("end", () => {
				const last = this.lines.join("\n");
				this.lines = [""];
				this.row = 0;
				this.col = 0;
				if (last) this.emitLine(last);
				this.emitClose();
			});
		}
	}

	on(event: "line", listener: (line: string) => void): this;
	on(event: "close", listener: () => void): this;
	on(event: "line" | "close", listener: (line: string) => void): this {
		if (event === "line") {
			this.listeners.line = listener;
		} else {
			this.listeners.close = listener as () => void;
		}
		return this;
	}

	setPrompt(prompt: string): void {
		this.promptStr = prompt;
		if (this.input.isTTY) this.render();
	}

	prompt(_preserveCursor?: boolean): void {
		if (this.input.isTTY) this.render();
	}

	write(s: string): void {
		this.insertText(s);
	}

	reset(): void {
		this.lines = [""];
		this.row = 0;
		this.col = 0;
		this.historyIndex = -1;
		this.stash = null;
		if (this.input.isTTY) this.render();
	}

	question(query: string, cb: (answer: string) => void): void {
		this.questionCb = cb;
		this.promptStr = query;
		this.lines = [""];
		this.row = 0;
		this.col = 0;
		if (this.input.isTTY) this.render();
	}

	close(): void {
		if (this.isDone) return;
		this.isDone = true;
		this.disableTerminalProtocols();
		if (this.rawMode && this.input.setRawMode) {
			this.input.setRawMode(false);
		}
		this.emitClose();
	}

	// ---- input handling ----

	private onData(buf: Buffer): void {
		if (this.isDone) return;
		let text = buf.toString("utf-8");
		text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const parts = text.split("\n");
		for (let i = 0; i < parts.length; i++) {
			if (i < parts.length - 1) {
				this.emitLine(parts[i]);
				this.lines = [""];
				this.row = 0;
				this.col = 0;
			} else if (parts[i]) {
				this.emitLine(parts[i]);
				this.lines = [""];
				this.row = 0;
				this.col = 0;
			}
		}
	}

	private onKey(str: string, key: unknown): void {
		if (this.isDone) return;
		if (this.onKeyInput && this.onKeyInput(str, key)) return;

		const k = key as {
			name?: string;
			sequence?: string;
			ctrl?: boolean;
			meta?: boolean;
		};
		const name = k?.name ?? "undefined";
		const seq = k?.sequence ?? str ?? "";

		if (name === "undefined" && /^\x1b\[\d+(?:;\d+)?u$/.test(seq)) {
			const m = seq.match(/^\x1b\[(\d+)(?:;(\d+))?u$/);
			if (m && Number(m[1]) === 13 && Number(m[2] ?? 0) !== 0) {
				this.insertNewline();
			}
			return;
		}

		if (name === "paste-start" || seq === "\x1b[200~") {
			this.isPaste = true;
			return;
		}
		if (name === "paste-end" || seq === "\x1b[201~") {
			this.isPaste = false;
			this.render();
			return;
		}
		if (this.isPaste) {
			if (name === "return" || seq === "\r" || seq === "\n") {
				this.insertText("\n");
			} else if (str) {
				this.insertText(str);
			}
			this.render();
			return;
		}

		if (name === "return" && (seq === "\x1b\r" || k.meta)) {
			this.insertNewline();
			return;
		}
		if (name === "undefined" && seq === "\x1b\r") {
			this.insertNewline();
			return;
		}
		if (k?.ctrl && name === "j") {
			this.insertNewline();
			return;
		}
		if (name === "escape") return;

		switch (name) {
			case "return":
				this.lastWasCR = true;
				this.submit();
				return;
			case "enter":
				if (this.lastWasCR) {
					this.lastWasCR = false;
					return;
				}
				this.insertNewline();
				return;
			case "backspace":
				this.lastWasCR = false;
				this.backspace();
				return;
			case "delete":
				this.lastWasCR = false;
				this.deleteForward();
				return;
			case "left":
				this.lastWasCR = false;
				this.moveLeft();
				return;
			case "right":
				this.lastWasCR = false;
				this.moveRight();
				return;
			case "up":
				this.lastWasCR = false;
				this.moveUp();
				return;
			case "down":
				this.lastWasCR = false;
				this.moveDown();
				return;
			case "home":
				this.lastWasCR = false;
				this.moveHome();
				return;
			case "end":
				this.lastWasCR = false;
				this.moveEnd();
				return;
			case "pageup":
				this.lastWasCR = false;
				this.moveToStart();
				return;
			case "pagedown":
				this.lastWasCR = false;
				this.moveToEnd();
				return;
			case "tab":
				this.lastWasCR = false;
				this.tabComplete();
				return;
		}

		if (k?.ctrl) {
			this.lastWasCR = false;
			switch (name) {
				case "c":
					this.ctrlC();
					return;
				case "d":
					this.ctrlD();
					return;
				case "a":
					this.moveHome();
					return;
				case "e":
					this.moveEnd();
					return;
				case "u":
					this.killToStart();
					return;
				case "k":
					this.killToEnd();
					return;
				case "w":
					this.killWordBefore();
					return;
				case "l":
					this.clearScreen();
					return;
				default:
					return;
			}
		}

		if (k?.meta) {
			this.lastWasCR = false;
			switch (name) {
				case "b":
					this.moveWordLeft();
					return;
				case "f":
					this.moveWordRight();
					return;
				case "d":
					this.killWordAfter();
					return;
				default:
					return;
			}
		}

		if (str && !/^[\u0000-\u001f\u007f]/.test(str)) {
			this.lastWasCR = false;
			this.insertText(str);
		}
	}

	private submit(): void {
		if (this.questionCb) {
			const cb = this.questionCb;
			this.questionCb = null;
			const answer = this.lines.join("\n").trim();
			this.lines = [""];
			this.row = 0;
			this.col = 0;
			this.render();
			cb(answer);
			return;
		}
		const text = this.lines.join("\n");
		if (text.trim()) {
			this.history.push(text);
			if (this.history.length > this.historySize) {
				this.history = this.history.slice(-this.historySize);
			}
		}
		this.historyIndex = -1;
		this.stash = null;
		this.lines = [""];
		this.row = 0;
		this.col = 0;
		this.render();
		this.emitLine(text);
	}

	private ctrlC(): void {
		this.lines = [""];
		this.row = 0;
		this.col = 0;
		this.render();
		process.emit("SIGINT");
	}

	private ctrlD(): void {
		if (this.lines.length === 1 && this.lines[0] === "") {
			this.emitClose();
		} else {
			this.deleteForward();
		}
	}

	// ---- editing primitives ----

	private currentChars(): string[] {
		return Array.from(this.lines[this.row]);
	}

	private setCurrentChars(chars: string[]): void {
		this.lines[this.row] = chars.join("");
	}

	private insertText(text: string): void {
		const sanitized = text.replace(/\r\n/g, "\n").replace(/\r/g, "");
		const chars = this.currentChars();
		const t = Array.from(sanitized);
		chars.splice(this.col, 0, ...t);
		this.setCurrentChars(chars);
		this.col += t.length;
		this.render();
	}

	private insertNewline(): void {
		const chars = this.currentChars();
		const rest = chars.slice(this.col).join("");
		this.setCurrentChars(chars.slice(0, this.col));
		this.lines.splice(this.row + 1, 0, rest);
		this.row++;
		this.col = 0;
		this.render();
	}

	private backspace(): void {
		const chars = this.currentChars();
		if (this.col > 0) {
			chars.splice(this.col - 1, 1);
			this.setCurrentChars(chars);
			this.col--;
		} else if (this.row > 0) {
			const prevLen = charLen(this.lines[this.row - 1]);
			this.lines[this.row - 1] =
				this.lines[this.row - 1] + this.lines[this.row];
			this.lines.splice(this.row, 1);
			this.row--;
			this.col = prevLen;
		}
		this.render();
	}

	private deleteForward(): void {
		const chars = this.currentChars();
		if (this.col < chars.length) {
			chars.splice(this.col, 1);
			this.setCurrentChars(chars);
		} else if (this.row < this.lines.length - 1) {
			this.lines[this.row] =
				this.lines[this.row] + this.lines[this.row + 1];
			this.lines.splice(this.row + 1, 1);
		}
		this.render();
	}

	private killToStart(): void {
		const chars = this.currentChars();
		this.setCurrentChars(chars.slice(this.col));
		this.col = 0;
		this.render();
	}

	private killToEnd(): void {
		const chars = this.currentChars();
		this.setCurrentChars(chars.slice(0, this.col));
		this.render();
	}

	private killWordBefore(): void {
		const chars = this.currentChars();
		let i = this.col;
		while (i > 0 && /\s/.test(chars[i - 1])) i--;
		while (i > 0 && !/\s/.test(chars[i - 1])) i--;
		chars.splice(i, this.col - i);
		this.setCurrentChars(chars);
		this.col = i;
		this.render();
	}

	private killWordAfter(): void {
		const chars = this.currentChars();
		const n = chars.length;
		let i = this.col;
		while (i < n && /\s/.test(chars[i])) i++;
		while (i < n && !/\s/.test(chars[i])) i++;
		chars.splice(this.col, i - this.col);
		this.setCurrentChars(chars);
		this.render();
	}

	// ---- navigation ----

	private moveLeft(): void {
		if (this.col > 0) {
			this.col--;
		} else if (this.row > 0) {
			this.row--;
			this.col = charLen(this.lines[this.row]);
		}
		this.render();
	}

	private moveRight(): void {
		if (this.col < charLen(this.lines[this.row])) {
			this.col++;
		} else if (this.row < this.lines.length - 1) {
			this.row++;
			this.col = 0;
		}
		this.render();
	}

	private moveUp(): void {
		const layout = this.layout();
		const idx = layoutIndexFor(layout, this.row, this.col);
		const vcol = visualColAt(layout, idx, this.col);
		if (idx > 0) {
			const target = layout[idx - 1];
			this.row = target.bufRow;
			this.col = charOffsetFor(layout, idx - 1, vcol);
			this.render();
		} else {
			this.historyPrev();
		}
	}

	private moveDown(): void {
		const layout = this.layout();
		const idx = layoutIndexFor(layout, this.row, this.col);
		const vcol = visualColAt(layout, idx, this.col);
		if (idx < layout.length - 1) {
			const target = layout[idx + 1];
			this.row = target.bufRow;
			this.col = charOffsetFor(layout, idx + 1, vcol);
			this.render();
		} else {
			this.historyNext();
		}
	}

	private moveHome(): void {
		this.col = 0;
		this.render();
	}

	private moveEnd(): void {
		this.col = charLen(this.lines[this.row]);
		this.render();
	}

	private moveToStart(): void {
		this.row = 0;
		this.col = 0;
		this.render();
	}

	private moveToEnd(): void {
		this.row = this.lines.length - 1;
		this.col = charLen(this.lines[this.row]);
		this.render();
	}

	private moveWordLeft(): void {
		const chars = this.currentChars();
		let i = this.col;
		while (i > 0 && /\s/.test(chars[i - 1])) i--;
		while (i > 0 && !/\s/.test(chars[i - 1])) i--;
		this.col = i;
		this.render();
	}

	private moveWordRight(): void {
		const chars = this.currentChars();
		const n = chars.length;
		let i = this.col;
		while (i < n && !/\s/.test(chars[i])) i++;
		while (i < n && /\s/.test(chars[i])) i++;
		this.col = i;
		this.render();
	}

	private historyPrev(): void {
		if (this.history.length === 0) return;
		if (this.historyIndex === -1) {
			this.stash = {
				lines: this.lines.slice(),
				row: this.row,
				col: this.col,
			};
			this.historyIndex = 0;
		} else if (this.historyIndex < this.history.length - 1) {
			this.historyIndex++;
		} else {
			return;
		}
		this.applyHistoryEntry();
	}

	private historyNext(): void {
		if (this.historyIndex === -1) return;
		if (this.historyIndex > 0) {
			this.historyIndex--;
			this.applyHistoryEntry();
		} else if (this.stash) {
			this.lines = this.stash.lines.slice();
			this.row = this.stash.row;
			this.col = this.stash.col;
			this.historyIndex = -1;
			this.stash = null;
			this.render();
		}
	}

	private applyHistoryEntry(): void {
		const entry = this.history[this.history.length - 1 - this.historyIndex];
		this.lines = entry.split("\n");
		if (this.lines.length === 0) this.lines = [""];
		this.row = this.lines.length - 1;
		this.col = charLen(this.lines[this.row]);
		this.render();
	}

	// ---- completion / misc ----

	private tabComplete(): void {
		if (!this.completer) return;
		const line = this.lines[this.row];
		const [matches, partial] = this.completer(line);
		if (matches.length === 0) {
			this.output.write("\x07");
			return;
		}
		if (matches.length === 1) {
			const from = line.lastIndexOf(partial);
			const head = line.slice(0, from);
			const tail = line.slice(from + partial.length);
			this.lines[this.row] = head + matches[0] + tail;
			this.col = charLen(head) + charLen(matches[0]);
			this.render();
			return;
		}
		const lines = matches.map((m) => "  " + m);
		this.output.write("\r\n" + lines.join("\r\n") + "\r\n");
		this.output.write(`\x1b[${lines.length + 1}A`);
		this.render();
	}

	private clearScreen(): void {
		this.output.write("\x1b[2J\x1b[H");
		this.render();
	}

	// ---- rendering ----

	private columns(): number {
		return this.output.columns || 80;
	}

	private layout(): LayoutRow[] {
		return buildLayout(this.lines, this.columns());
	}

	private render(): void {
		if (!this.input.isTTY || this.isDone) return;
		const layout = this.layout();
		const promptWidth = stringWidth(stripAnsi(this.promptStr));
		const idx = layoutIndexFor(layout, this.row, this.col);
		const vcol = visualColAt(layout, idx, this.col);
		const rowsAfter = layout.length - idx - 1;
		const ccol = (idx === 0 ? promptWidth : 0) + vcol;

		const out: string[] = ["\r"];
		for (let i = 0; i < layout.length; i++) {
			out.push("\x1b[2K");
			if (i === 0) out.push(this.promptStr);
			out.push(layout[i].text);
			if (i < layout.length - 1) out.push("\r\n");
		}
		out.push("\x1b[J");
		if (rowsAfter > 0) out.push(`\x1b[${rowsAfter}A`);
		out.push("\r");
		if (ccol > 0) out.push(`\x1b[${ccol}C`);
		this.output.write(out.join(""));
	}

	private enableTerminalProtocols(): void {
		this.output.write("\x1b[?2004h");
		this.output.write("\x1b[>1u");
	}

	private disableTerminalProtocols(): void {
		this.output.write("\x1b[?2004l");
		this.output.write("\x1b[<u");
	}

	private emitLine(line: string): void {
		this.listeners.line?.(line);
	}

	private emitClose(): void {
		this.listeners.close?.();
	}
}