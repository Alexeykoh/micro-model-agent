/**
 * Обработка клавиш и действий редактора: paste-машина, ранние escape-ветки,
 * диспетчеризация, submit, Ctrl+C/Ctrl+D и вертикальная навигация. Вынесено из
 * `line-editor.ts` (правило 6); порядок веток и сайд-эффекты сохранены.
 */
import { charOffsetFor, layoutIndexFor, visualColAt } from "./line-math";
import * as nav from "./line-editor-nav";
import {
  classifyEscape,
  classifyKey,
  keyInfo,
  type CtrlOp,
  type EditOp,
  type MetaOp,
} from "./line-editor-keys";
import { cancelCompletion, cycleCompletion, tabComplete, type CompletionHost } from "./line-editor-completion";
import type { LineBuffer } from "./line-editor-buffer";
import type { LineRenderer } from "./line-editor-render";
import type { EditorOutput } from "./line-editor-types";

/** Всё, что нужно обработке клавиш от редактора. */
export interface InputDeps {
  buf: LineBuffer;
  frames: LineRenderer;
  output: EditorOutput;
  isDone(): boolean;
  inputEnabled(): boolean;
  /** Хост-хук: true — клавиша поглощена. */
  hostKey(str: string, key: unknown): boolean;
  completion(): CompletionHost;
  question(): ((answer: string) => void) | null;
  clearQuestion(): void;
  render(): void;
  emitLine(line: string): void;
  close(): void;
  onInterrupt?: () => void;
}

/** Состояние ввода + обработка клавиш и submit-пути. */
export class EditorInput {
  private isPaste = false;
  /** Вставленное копятся между `paste-start` и `paste-end`.
   *  Вставляется одним батчем на `paste-end`: один рендер вместо рендера на
   *  клавишу, чтобы вставка выглядела вставкой, а не быстрой печатью. */
  private pasteBuffer = "";
  /** Была ли последняя вставленная клавиша голым CR: схлопывает CRLF-пару
   *  в один перевод строки (текст из буфера Windows). */
  private pasteLastWasCR = false;
  private lastWasCR = false;

  private readonly editOps: Record<EditOp, () => void> = {
    backspace: () => this.deps.buf.backspace(), delete: () => this.deps.buf.deleteForward(),
    left: () => nav.moveLeft(this.deps.buf), right: () => nav.moveRight(this.deps.buf),
    up: () => this.moveUp(), down: () => this.moveDown(),
    home: () => nav.moveHome(this.deps.buf), end: () => nav.moveEnd(this.deps.buf),
    pageup: () => nav.moveToStart(this.deps.buf), pagedown: () => nav.moveToEnd(this.deps.buf),
  };
  private readonly ctrlOps: Record<CtrlOp, () => void> = {
    c: () => this.ctrlC(), d: () => this.ctrlD(),
    a: () => nav.moveHome(this.deps.buf), e: () => nav.moveEnd(this.deps.buf),
    u: () => this.deps.buf.killToStart(), k: () => this.deps.buf.killToEnd(),
    w: () => this.deps.buf.killWordBefore(), l: () => this.clearScreen(),
  };
  private readonly metaOps: Record<MetaOp, () => void> = {
    b: () => nav.moveWordLeft(this.deps.buf),
    f: () => nav.moveWordRight(this.deps.buf),
    d: () => this.deps.buf.killWordAfter(),
  };

  constructor(private readonly deps: InputDeps) {}

  private clearScreen(): void {
    this.deps.output.write("\x1b[2J\x1b[H");
    this.deps.frames.invalidate();
    this.deps.render();
  }

  handleKey(str: string, key: unknown): void {
    const d = this.deps;
    if (d.isDone()) return;
    if (!d.inputEnabled()) {
      // На стриме уважаются только прерывающие клавиши: Ctrl+C абортит прогон,
      // Esc форвардится, чтобы хост реализовал двойной-Esc аборт.
      const k = key as { name?: string; ctrl?: boolean };
      if (k?.ctrl && k.name === "c") {
        this.ctrlC();
        return;
      }
      if (k?.name === "escape") {
        d.hostKey(str, key);
        return;
      }
      return;
    }
    // Сессия комплита приоритетнее хост-хуков: Esc обязан вернуть исходный
    // partial, а не дёрнуть хостовый Esc-хендлинг; стрелки/Tab — крутить.
    // Любая другая клавиша роняет сессию и обрабатывается обычно (с хост-хуком).
    if (d.buf.completion) {
      const ck = key as { name?: string; ctrl?: boolean; meta?: boolean };
      const plain = !ck.ctrl && !ck.meta;
      if (ck?.name === "down" && plain) {
        cycleCompletion(d.completion(), 1);
        return;
      }
      if (ck?.name === "up" && plain) {
        cycleCompletion(d.completion(), -1);
        return;
      }
      if (ck?.name === "tab") {
        cycleCompletion(d.completion(), 1);
        return;
      }
      if (ck?.name === "escape") {
        cancelCompletion(d.completion());
        return;
      }
      d.buf.completion = null;
    }

    if (d.hostKey(str, key)) return;

    const { name, seq } = keyInfo(str, key);
    const early = classifyEscape(name, seq);
    if (early) {
      if (early === "newline") d.buf.insertNewline();
      return;
    }
    if (name === "paste-start" || seq === "\x1b[200~") {
      this.isPaste = true;
      this.pasteBuffer = "";
      this.pasteLastWasCR = false;
      return;
    }
    if (name === "paste-end" || seq === "\x1b[201~") {
      this.isPaste = false;
      if (this.pasteBuffer) {
        d.buf.insertPaste(this.pasteBuffer);
      } else {
        d.render();
      }
      this.pasteBuffer = "";
      this.pasteLastWasCR = false;
      return;
    }
    if (this.isPaste) {
      if (name === "return" || seq === "\r") {
        this.pasteBuffer += "\n";
        this.pasteLastWasCR = true;
      } else if (name === "enter" || seq === "\n") {
        if (this.pasteLastWasCR) {
          this.pasteLastWasCR = false;
        } else {
          this.pasteBuffer += "\n";
        }
      } else if (str) {
        this.pasteLastWasCR = false;
        this.pasteBuffer += str;
      }
      return;
    }

    const action = classifyKey(str, key);
    switch (action.kind) {
      case "ignore":
      case "none":
        return;
      case "newline":
        d.buf.insertNewline();
        return;
      case "return":
        this.lastWasCR = true;
        this.submit();
        return;
      case "enter":
        if (this.lastWasCR) {
          this.lastWasCR = false;
          return;
        }
        // В question-режиме LF тоже сабмитит (скрипты/пайпы шлют \n без \r спереди,
        // в отличие от настоящих терминалов).
        if (d.question()) {
          this.submit();
          return;
        }
        d.buf.insertNewline();
        return;
      case "edit":
        this.lastWasCR = false;
        this.editOps[action.op]();
        return;
      case "tab":
        this.lastWasCR = false;
        tabComplete(d.completion());
        return;
      case "ctrl":
        this.lastWasCR = false;
        this.ctrlOps[action.op]();
        return;
      case "meta":
        this.lastWasCR = false;
        this.metaOps[action.op]();
        return;
      case "insert":
        this.lastWasCR = false;
        d.buf.insertText(action.text);
        return;
    }
  }

  submit(): void {
    const d = this.deps;
    d.buf.completion = null;
    const question = d.question();
    if (question) {
      d.clearQuestion();
      const answer = d.buf.lines.join("\n").trim();
      d.output.write(d.frames.commitSeq());
      d.output.write("\r\n");
      d.frames.invalidate();
      d.buf.lines = [""];
      d.buf.row = 0;
      d.buf.col = 0;
      question(answer);
      return;
    }
    const text = d.buf.text();
    nav.recordHistory(d.buf, text);
    d.output.write(d.frames.commitSeq());
    d.output.write("\r\n");
    d.frames.invalidate();
    d.buf.lines = [""];
    d.buf.row = 0;
    d.buf.col = 0;
    d.emitLine(text);
  }

  ctrlC(): void {
    const d = this.deps;
    d.buf.lines = [""];
    d.buf.row = 0;
    d.buf.col = 0;
    d.buf.completion = null;
    d.frames.invalidate();
    d.render();
    if (d.onInterrupt) {
      d.onInterrupt();
      return;
    }
    // Дефолт: эмитим, только если слушают. С нулём хендлеров process.emit("SIGINT")
    // выполняет действие ПО УМОЛЧАНИЮ (смерть процесса); у REPL слушатель всегда
    // стоит, так что прод не страдает.
    if (process.listenerCount("SIGINT") > 0) {
      process.emit("SIGINT");
    }
  }

  private ctrlD(): void {
    if (this.deps.buf.isEmpty()) {
      // Пустая строка + Ctrl+D = выход из сессии: редактор закрывается целиком
      // (raw-режим снят) — иначе терминал остаётся в raw и процесс «висит» (§8.11).
      this.deps.close();
    } else {
      this.deps.buf.deleteForward();
    }
  }

  private moveUp(): void {
    const b = this.deps.buf;
    const layout = this.deps.frames.layout();
    const idx = layoutIndexFor(layout, b.row, b.col);
    const vcol = visualColAt(layout, idx, b.col);
    if (idx > 0) {
      const target = layout[idx - 1];
      nav.applyMove(b, target.bufRow, charOffsetFor(layout, idx - 1, vcol));
    } else {
      nav.historyPrev(b);
    }
  }

  private moveDown(): void {
    const b = this.deps.buf;
    const layout = this.deps.frames.layout();
    const idx = layoutIndexFor(layout, b.row, b.col);
    const vcol = visualColAt(layout, idx, b.col);
    if (idx < layout.length - 1) {
      const target = layout[idx + 1];
      nav.applyMove(b, target.bufRow, charOffsetFor(layout, idx + 1, vcol));
    } else {
      nav.historyNext(b);
    }
  }
}
