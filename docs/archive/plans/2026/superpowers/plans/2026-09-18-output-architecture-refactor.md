# Output Architecture Refactor — Implementation Plan (v2)

> **Статус:** исполнено (2026-10-20) — `src/output/{types,bus,channel,format,machine,json-sink,session-sink,source}.ts`,
> `src/tools/prompt-io.ts`, streaming/modal/quiet в канале, гвард
> `tests/output/no-direct-console.test.ts`. Чекбоксы проставлены по факту.
> Отклонения: `src/output/plugin-bridge.ts` удалён намеренно (`a43dfc73`),
> `subscribeOutput` реализован через `src/core/host.ts`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить четыре независимых пути записи в терминал (Logger→`console.log`, `Renderer`/`Spinner`→stdout/stderr, ручные ANSI-хаки REPL, прямой stdout в CLI/тулах) единой событийной шиной вывода с **единственным владельцем терминала**, который учитывает режим (idle/streaming/modal/quiet), умеет печатать над prompt'ом `LineEditor` и корректно стримить markdown, не ломая поле ввода.

**Architecture:** `src/output/` — `OutputBus` (pub/sub), `OutputChannel` (единственный писатель; режимы `idle|streaming|modal|quiet`; очередь; частичная строка; singleton `getDefaultChannel()`), `format.ts`, подписчики `json`/`session`/`plugin`. `Logger` эмитит события вместо `console.log`. `Renderer`/`Spinner`/REPL/CLI/тулы пишут через канал. `LineEditor` получает `printAbove`, `suspendFrame`/`resumeFrame`, `setInputEnabled` и починенный DSR-якорь. Wizard запускается до `bootstrap()`.

**Tech Stack:** Bun + TypeScript (ES2022, NodeNext), vitest (`bun test`), picocolors, string-width. Новых runtime-зависимостей нет.

---

## Модель владения терминалом (ключевое решение)

Один физический терминал, один владелец в каждый момент. `OutputChannel` имеет режим:

| Режим | Кто владеет | Что делает с событиями |
|---|---|---|
| `idle` | prompt `LineEditor` (если active) | `log`/`block` → `prompt.printAbove()`; `raw` → буфер до `\n`, затем `printAbove`; иначе прямой stdout |
| `streaming` | агент | всё → прямой passthrough; перед `log`/`block` закрывает незакрытую частичную строку `\n`; `Spinner` — транзиентный overlay на stderr |
| `modal` | wizard / тул `question`/`approve` | всё в очередь; `endModal()` флашит FIFO |
| `quiet` | `--json` | человеческий вывод дропается; машиночитаемое — через `JsonOutputSink` |

Переходы: REPL `runAgent` → `beginStreaming()` + `rl.suspendFrame()` + `rl.setInputEnabled(false)`; по завершении → `endStreaming()` + `rl.setInputEnabled(true)` + `rl.prompt()`. Интерактивный тул → `beginModal()`/`endModal()`. `--json` → `setQuiet(true)`.

Инварианты:
1. Только `OutputChannel` и `src/output/machine.ts` пишут в `process.stdout`/`stderr` (allowlist: crash-handler, bridge-server).
2. Ровно один продовый канал на процесс — `getDefaultChannel()` (иначе дубли подписок).
3. `log`/`block` никогда не вклиниваются в незакрытую частичную строку стрима.
4. `modal` ничего не теряет (очередь), `quiet` не пишет человеческий вывод.
5. `Spinner` не буферизуется как событие и не печатается при активном prompt.

---

## Интерфейсы (канонические)

`src/output/types.ts`:

```ts
export type OutputLevel = "debug" | "info" | "warn" | "error";
export type OutputKind = "log" | "raw" | "block";
export type OutputStream = "stdout" | "stderr";

export interface OutputEvent {
  id: number;
  ts: number;
  level: OutputLevel;
  /** Тег производителя: "mma", "indexer", "probe.context", "tool:bash". */
  source: string;
  kind: OutputKind;
  /** Терминально-готовый текст (может содержать ANSI). */
  text: string;
  stream?: OutputStream;
  /** Машиночитаемая нагрузка для не-терминальных поверхностей. */
  data?: Record<string, unknown>;
}

export type OutputSubscriber = (ev: OutputEvent) => void;

export interface OutputSink {
  emit(ev: Omit<OutputEvent, "id" | "ts">): OutputEvent;
}
```

`src/output/bus.ts`:

```ts
import type { OutputEvent, OutputLevel, OutputSink, OutputSubscriber } from "./types";

export class OutputBus implements OutputSink {
  private seq = 0;
  private readonly subs = new Set<OutputSubscriber>();

  subscribe(fn: OutputSubscriber): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit(ev: Omit<OutputEvent, "id" | "ts">): OutputEvent {
    const full: OutputEvent = { ...ev, id: ++this.seq, ts: Date.now() };
    for (const fn of this.subs) {
      try {
        fn(full);
      } catch {
        /* подписчик не должен ломать шину */
      }
    }
    return full;
  }

  log(level: OutputLevel, source: string, text: string, data?: Record<string, unknown>): OutputEvent {
    return this.emit({ level, source, kind: "log", text, data });
  }
}

export const defaultOutputBus = new OutputBus();
```

`src/output/channel.ts` — режимы, очередь, частичная строка, singleton:

```ts
import pc from "picocolors";
import { defaultOutputBus, type OutputBus } from "./bus";
import { formatEventLine } from "./format";
import type { OutputEvent, OutputStream } from "./types";

export interface PromptSink {
  isActive(): boolean;
  printAbove(text: string): void;
}

export type ChannelMode = "idle" | "streaming" | "modal" | "quiet";

export interface OutputChannelOptions {
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  color?: boolean;
}

export class OutputChannel {
  private out: NodeJS.WritableStream;
  private err: NodeJS.WritableStream;
  private color: boolean;
  private mode: ChannelMode = "idle";
  private sink: PromptSink | null = null;
  private queue: OutputEvent[] = [];
  private pending: { stream: OutputStream; text: string } | null = null;
  /** true, если последний passthrough в stdout не закончился \n. */
  private partialOpen = false;
  private readonly unsub: () => void;

  constructor(private bus: OutputBus = defaultOutputBus, opts: OutputChannelOptions = {}) {
    this.out = opts.out ?? process.stdout;
    this.err = opts.err ?? process.stderr;
    this.color = opts.color ?? (!process.env.NO_COLOR && !process.env.CI);
    this.unsub = this.bus.subscribe((ev) => this.onEvent(ev));
  }

  dispose(): void {
    this.unsub();
    this.queue = [];
    this.pending = null;
  }

  attachPrompt(sink: PromptSink | null): void {
    this.sink = sink;
  }

  getMode(): ChannelMode {
    return this.mode;
  }

  beginStreaming(): void {
    this.flushPendingAsBlock();
    this.mode = "streaming";
  }

  endStreaming(): void {
    this.closePartial();
    this.mode = "idle";
  }

  beginModal(): void {
    this.flushPendingAsBlock();
    this.mode = "modal";
  }

  endModal(): void {
    this.mode = "idle";
    const q = this.queue;
    this.queue = [];
    for (const ev of q) this.onEvent(ev);
  }

  setQuiet(quiet: boolean): void {
    this.mode = quiet ? "quiet" : "idle";
  }

  /** Прямая запись (Renderer, diff, markdown). */
  writeRaw(text: string, stream: OutputStream = "stdout"): void {
    if (this.mode === "modal" || this.mode === "quiet") return;
    if (this.mode === "idle" && this.sink?.isActive() && stream === "stdout") {
      this.pending = {
        stream,
        text: (this.pending?.stream === stream ? this.pending.text : "") + text,
      };
      this.drainPending(false);
      return;
    }
    if (stream === "stdout") this.partialOpen = !text.endsWith("\n");
    (stream === "stderr" ? this.err : this.out).write(text);
  }

  /** Одна готовая строка (баннеры, справка, CLI). */
  writeLine(text: string, stream: OutputStream = "stdout"): void {
    this.bus.emit({ level: "info", source: "", kind: "block", text, stream });
  }

  /** Транзиентный overlay спиннера: только когда prompt не владеет экраном. */
  writeOverlay(text: string): void {
    if (this.mode === "modal" || this.mode === "quiet") return;
    if (this.mode === "idle" && this.sink?.isActive()) return;
    this.err.write(text);
  }

  private onEvent(ev: OutputEvent): void {
    if (this.mode === "quiet") return;
    if (this.mode === "modal") {
      this.queue.push(ev);
      return;
    }
    if (ev.kind === "raw") {
      this.writeRaw(ev.text, ev.stream);
      return;
    }
    const stream = ev.stream ?? "stdout";
    const line = ev.kind === "block" ? ev.text : formatEventLine(ev, this.color);
    if (stream === "stdout" && this.mode === "idle" && this.sink?.isActive()) {
      this.flushPendingAsBlock();
      this.sink.printAbove(line);
      return;
    }
    if (this.mode === "streaming") this.closePartial();
    (stream === "stderr" ? this.err : this.out).write(`${line}\n`);
  }

  private closePartial(): void {
    if (this.partialOpen) {
      this.out.write("\n");
      this.partialOpen = false;
    }
  }

  private drainPending(final: boolean): void {
    if (!this.pending) return;
    const { stream, text } = this.pending;
    const idx = final ? text.length : text.lastIndexOf("\n");
    if (idx < 0) return;
    const head = text.slice(0, idx + (final ? 0 : 1));
    this.pending = final ? null : { stream, text: text.slice(idx + 1) };
    const lines = head.replace(/\n$/, "").split("\n");
    if (this.sink?.isActive()) this.sink.printAbove(lines.join("\n"));
    else this.out.write(head);
  }

  private flushPendingAsBlock(): void {
    if (this.pending) {
      const text = this.pending.text;
      const { stream } = this.pending;
      this.pending = null;
      if (this.sink?.isActive()) this.sink.printAbove(text);
      else (stream === "stderr" ? this.err : this.out).write(text);
    }
    this.partialOpen = false;
  }
}

let defaultChannel: OutputChannel | null = null;

export function getDefaultChannel(): OutputChannel {
  if (!defaultChannel) defaultChannel = new OutputChannel(defaultOutputBus);
  return defaultChannel;
}

/** Только для тестов: сбросить singleton. */
export function resetDefaultChannel(): void {
  defaultChannel?.dispose();
  defaultChannel = null;
}
```

`src/output/machine.ts` — единственный легальный прямой stdout для машинных форматов:

```ts
/** Машиночитаемый вывод (JSON-контракты CLI). Единственное место с raw stdout. */
export function writeMachineJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
```

`src/output/format.ts`, `json-sink.ts`, `session-sink.ts`, `plugin-bridge.ts` — см. Task 2 и Task 12.

`LineInput` дополняется:

```ts
export interface LineInput {
  setPrompt(prompt: string): void;
  prompt(preserveCursor?: boolean): void;
  write(s: string): void;
  question(query: string, cb: (answer: string) => void): void;
  close(): void;
  /** Опционально: напечатать блок над кадром (только LineEditor). */
  printAbove?(text: string): void;
  on(event: "line", listener: (line: string) => void): this;
  on(event: "close", listener: () => void): this;
}
```

`PromptIO` для интерактивных тулов:

```ts
// src/tools/types.ts
export interface PromptIO {
  askText(prompt: string, defaultValue?: string): Promise<string>;
  askChoice(opts: {
    message: string;
    options: Array<{ label: string; value: string }>;
    multi?: boolean;
    custom?: boolean;
  }): Promise<string>;
}
```

---

## Карта файлов

**Создать:** `src/output/{types,bus,channel,format,machine,json-sink,session-sink,plugin-bridge,index}.ts`; `tests/output/{bus,channel,format,json-sink,no-direct-console,logger-bus}.test.ts`; `src/cli/setup-order.ts`; `src/tools/prompt-io.ts`.

**Изменить (ключевое):** `src/ui/line-editor.ts`; `src/logger/app-logger.ts`; `src/ui/{renderer,spinner,output}.ts`; `src/ui/md-formatter.ts` (flush-guard); `src/cli/{repl,repl-commands,main,setup,commands,run-result,security-commands,plugin-commands}.ts`; `src/core/{bootstrap,session-logger}.ts`; `src/tools/{types,question,approve,user-input,subagent}.ts`; `src/modules/types.ts`; `src/modules/plugins/manager.ts`; `src/config/{config,domains}.ts`; `src/index.ts`; `src/modules/certification/cli.ts`; `src/modules/mcp/{client,module}.ts`; `src/modules/security/{audit-notifier,session-encryption}.ts`; `src/modules/updater/module.ts`; `examples/plugins/{web-ui,trace-server}/*`; `AGENTS.md`, `CHANGELOG.md`, `package.json`, `docs/agents/architecture.md`.

---

## Матрица полноты (каждая поверхность → задача)

| Поверхность / риск | Задача |
|---|---|
| `Logger` → `console.log` (единственный пользовательский sink) | 5, 11 |
| `Renderer` (one-shot `main.ts:153`, REPL `runAgent`) | 6, 7 |
| `Spinner` stderr overlay, конфликт с prompt/стримом | 6, 7 |
| Частичный markdown `\x1b[ND` rewind (`md-formatter.ts:78-88`) | 6 (`flush-guard`) |
| Ручные ANSI-хаки REPL (`repl.ts:445,512,556,569,832,885`) | 7 |
| Prompt активен во время стрима; ввод рисует поверх (`line-editor` onKey) | 4 (`setInputEnabled`, `suspendFrame`), 7 |
| Интерактивные тулы: `user-input.ts:73-84,112,119`, `question`, `approve` (свой readline) | 8 |
| Фоновые пробы bootstrap (`bootstrap.ts:327-335,379`) | 10 |
| LSP/context/health баннеры (`repl.ts:832,859,885`) | 7, 10 |
| CLI-подкоманды (~60 `console.log`), bootstrap-пробы внутри них | 11 |
| REPL slash-команды (~90 `console.log`) | 7, 11 |
| `setup.ts` wizard `console.log` + свой Spinner | 9, 11 |
| `config.ts/domains.ts/index.ts` warnings | 11 |
| certification CLI (~25) | 11 |
| security: `audit-notifier`, `session-encryption`, `security-commands` | 11 |
| updater stderr адаптеры (`main.ts:30-32`, `module.ts:43-44`) | 11 |
| MCP client `console.error:135` (диагностика, не протокол) | 11 |
| Browser `bridge-server.mjs:231` NDJSON stdout (машинный, отдельный процесс) | allowlist (13) |
| `--json` JSON-документ (`main.ts:119-148`) + человеческий лог в него | 12 (`machine.ts`, quiet) |
| `config show` JSON (`commands.ts:108`) | 11 (`machine.ts`) |
| Crash-handler stderr | allowlist (13) |
| Плагины: HostBridge input-only → `subscribeOutput` | 12 |
| web-ui / trace-server: SSE broadcast + 2s polling | 12 |
| builtin `notify`, `lint-on-write` (через `ctx.logger`) | 5, 12 |
| i18n ключи (не удалить; новых output-ключей не требуется) | 14 |
| DSR-якорь отключён; тесты ждут отсутствия `\x1b[6n` | 4 |
| Дубли подписок при нескольких `new OutputChannel` | 3 (singleton), 6, 7 |
| `md-formatter` markdown-таблицы/код буферизованы | 6 |
| SessionLogger: машинные записи не дублировать | 12 |

---

## Task 0: Ветка и baseline

**Files:** none (git only).

- [x] **Step 1: Создать ветку**

Run: `git checkout -b refactor/output-architecture`
Expected: `Switched to a new branch`.

- [x] **Step 2: Baseline**

Run: `bun install && bun test && tsc --noEmit`
Expected: зелёно. Иначе — зафиксировать падающие тесты и согласовать до продолжения.

---

## Task 1: Output types и OutputBus

**Files:** Create `src/output/types.ts`, `src/output/bus.ts`, `src/output/index.ts`; Test `tests/output/bus.test.ts`.

- [x] **Step 1: Написать падающий тест** — `tests/output/bus.test.ts` (ids/timestamps, fan-out, unsubscribe, изоляция исключений):

```ts
import { describe, it, expect } from "vitest";
import { OutputBus } from "../../src/output/bus";

describe("OutputBus", () => {
  it("assigns monotonic ids and timestamps", () => {
    const bus = new OutputBus();
    const a = bus.emit({ level: "info", source: "mma", kind: "log", text: "a" });
    const b = bus.emit({ level: "info", source: "mma", kind: "log", text: "b" });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(b.ts).toBeGreaterThanOrEqual(a.ts);
  });
  it("delivers to every subscriber and stops after unsubscribe", () => {
    const bus = new OutputBus();
    const seen: string[] = [];
    const off = bus.subscribe((e) => seen.push(`a:${e.text}`));
    bus.subscribe((e) => seen.push(`b:${e.text}`));
    bus.log("warn", "indexer", "hello");
    off();
    bus.log("info", "s", "bye");
    expect(seen).toEqual(["a:hello", "b:hello", "b:bye"]);
  });
  it("isolates a throwing subscriber", () => {
    const bus = new OutputBus();
    const seen: string[] = [];
    bus.subscribe(() => { throw new Error("boom"); });
    bus.subscribe((e) => seen.push(e.text));
    expect(() => bus.log("info", "s", "x")).not.toThrow();
    expect(seen).toEqual(["x"]);
  });
});
```

- [x] **Step 2: Запустить — упадёт** → `bun test tests/output/bus.test.ts`
- [x] **Step 3: Создать `types.ts` и `bus.ts`** (код из «Интерфейсы»).
- [x] **Step 4: `index.ts`** — экспорт types + bus.
- [x] **Step 5: Прогнать** → `bun test tests/output/bus.test.ts && tsc --noEmit`
- [x] **Step 6: Commit** — `feat(output): add OutputEvent model and OutputBus`

---

## Task 2: formatEventLine

**Files:** Create `src/output/format.ts`; Modify `src/output/index.ts`; Test `tests/output/format.test.ts`.

- [x] **Step 1: Тест** — legacy-формат `[LEVEL] [source] ISO — text`, пустой source без скобок.
- [x] **Step 2: Упадёт** → `bun test tests/output/format.test.ts`
- [x] **Step 3: Реализовать** `format.ts` (код из «Интерфейсы»; `LEVEL_COLORS` переносятся из старого `app-logger.ts`).
- [x] **Step 4: Экспорт** в `index.ts`.
- [x] **Step 5: Прогнать** → PASS.
- [x] **Step 6: Commit** — `feat(output): add formatEventLine matching legacy logger format`

---

## Task 3: OutputChannel (режимы, очередь, singleton)

**Files:** Create `src/output/channel.ts`, `src/output/machine.ts`; Modify `index.ts`; Test `tests/output/channel.test.ts`.

- [x] **Step 1: Написать тесты** (idle→stdout, idle+prompt→printAbove, streaming passthrough + closePartial перед log, modal queue→flush, quiet drop, writeOverlay no-op при prompt, singleton, dispose):

```ts
import { describe, it, expect } from "vitest";
import { OutputBus } from "../../src/output/bus";
import { OutputChannel, getDefaultChannel, resetDefaultChannel, type PromptSink } from "../../src/output/channel";

class S { data = ""; write(s: string): boolean { this.data += s; return true; } }
function prompt(active = true) {
  const above: string[] = [];
  let on = active;
  const sink: PromptSink = { isActive: () => on, printAbove: (t) => above.push(t) };
  return { sink, above, set: (v: boolean) => (on = v) };
}
function ch() {
  const bus = new OutputBus();
  const out = new S();
  const err = new S();
  const c = new OutputChannel(bus, { out: out as never, err: err as never, color: false });
  return { bus, out, err, c };
}

describe("OutputChannel", () => {
  it("writes formatted lines to stdout in idle mode", () => {
    const { bus, out, c } = ch();
    bus.log("info", "indexer", "hello");
    expect(out.data).toContain("[INFO] [indexer]");
  });
  it("prints above the prompt when idle and prompt is active", () => {
    const { bus, out, c } = ch();
    const p = prompt(true);
    c.attachPrompt(p.sink);
    bus.log("warn", "probe.context", "big");
    expect(p.above).toEqual([expect.stringContaining("big")]);
    expect(out.data).toBe("");
  });
  it("passes streaming raw through and closes the partial before a log", () => {
    const { bus, out, c } = ch();
    c.beginStreaming();
    c.writeRaw("partial");
    expect(out.data.startsWith("partial")).toBe(true);
    bus.log("warn", "s", "note");
    // ключевое: перед log появился \n, закрывающий частичную строку
    expect(out.data.startsWith("partial\n[WARN] [s]")).toBe(true);
  });
  it("closes streaming with a newline", () => {
    const { c, out } = ch();
    c.beginStreaming();
    c.writeRaw("x", "stdout");
    c.endStreaming();
    expect(out.data.endsWith("x\n")).toBe(true);
  });
  it("queues during modal and flushes on endModal", () => {
    const { bus, out, c } = ch();
    c.beginModal();
    bus.log("info", "s", "later");
    expect(out.data).toBe("");
    c.endModal();
    expect(out.data).toContain("later");
  });
  it("drops human output in quiet mode", () => {
    const { bus, out, c } = ch();
    c.setQuiet(true);
    bus.log("error", "s", "boom");
    c.writeLine("banner");
    expect(out.data).toBe("");
  });
  it("writeOverlay is suppressed while prompt is active", () => {
    const { c, err } = ch();
    const p = prompt(true);
    c.attachPrompt(p.sink);
    c.writeOverlay("\rspin");
    expect(err.data).toBe("");
    c.beginStreaming();
    c.writeOverlay("\rspin");
    expect(err.data).toBe("\rspin");
  });
  it("singleton returns the same instance and resets", () => {
    resetDefaultChannel();
    expect(getDefaultChannel()).toBe(getDefaultChannel());
    resetDefaultChannel();
  });
});
```

- [x] **Step 2: Упадёт** → `bun test tests/output/channel.test.ts`
- [x] **Step 3: Реализовать** `channel.ts` + `machine.ts` (код из «Интерфейсы»).
- [x] **Step 4: Экспорт** в `index.ts`.
- [x] **Step 5: Прогнать** → PASS + `tsc --noEmit`.
- [x] **Step 6: Commit** — `feat(output): add OutputChannel with ownership modes and singleton`

---

## Task 4: LineEditor — printAbove, suspendFrame, setInputEnabled, DSR

**Files:** Modify `src/ui/line-editor.ts`; Test `tests/ui/line-editor-interactive.test.ts`, `tests/ui/line-editor.test.ts`.

- [x] **Step 1: Дописать падающие тесты**

```ts
  it("printAbove erases the frame, prints the block and redraws the prompt", () => {
    process.env.MMA_DSR = "0"; // тест проверяет тело блока, не DSR
    const { editor, output } = makeEditor();
    editor.prompt();
    output.data = "";
    editor.printAbove("hello\nworld");
    expect(output.data).toContain("hello\r\nworld\r\n");
    expect(output.data).toContain("> ");
    delete process.env.MMA_DSR;
  });

  it("printAbove writes plainly when not a TTY", () => {
    const input = new FakeInput();
    (input as { isTTY: boolean }).isTTY = false;
    const output = new FakeOutput();
    const editor = new LineEditor({ input: input as never, output: output as never, prompt: "> " });
    editor.printAbove("x");
    expect(output.data).toBe("x\n");
  });

  it("suspendFrame stops rendering and clears the frame; resumeFrame redraws", () => {
    process.env.MMA_DSR = "0";
    const { editor, input, output } = makeEditor();
    editor.prompt();
    editor.suspendFrame();
    output.data = "";
    input.pushData("abc"); // ввод выключен/кадр снят — рендера быть не должно
    // render() no-op при suspended
    editor.resumeFrame();
    expect(output.data).toContain("> ");
    delete process.env.MMA_DSR;
  });

  it("setInputEnabled(false) swallows printable keys but keeps Ctrl+C", async () => {
    const { editor, input, lines } = makeEditor();
    editor.setInputEnabled(false);
    input.pushData("abc\r");
    await tick();
    expect(lines).toEqual([]);
  });
```

- [x] **Step 2: Упадёт** → `bun test tests/ui/line-editor-interactive.test.ts`
- [x] **Step 3: Добавить состояние и методы**

В `LineEditor`:
```ts
  private inputEnabled = true;
  private frameSuspended = false;
  private dsrTimer: ReturnType<typeof setTimeout> | null = null;

  setInputEnabled(enabled: boolean): void { this.inputEnabled = enabled; }

  /** Снять кадр prompt'а (агент забирает терминал) и перестать рендерить. */
  suspendFrame(): void {
    if (!this.input.isTTY || this.isDone) return;
    const out: string[] = [];
    if (this.frameTopAbs !== null) out.push(`\x1b[${this.frameTopAbs};1H`);
    else if (this.prevCursorRow > 0) out.push(`\x1b[${this.prevCursorRow}A`);
    out.push("\r\x1b[J");
    this.output.write(out.join(""));
    this.invalidateAnchor();
    this.frameSuspended = true;
  }

  /** Вернуть кадр после завершения стрима. */
  resumeFrame(): void {
    this.frameSuspended = false;
    this.invalidateAnchor();
    this.render();
  }

  printAbove(text: string): void {
    if (!this.input.isTTY || this.isDone) {
      this.output.write(text.endsWith("\n") ? text : `${text}\n`);
      return;
    }
    const wasSuspended = this.frameSuspended;
    this.frameSuspended = false;
    const out: string[] = [];
    if (this.frameTopAbs !== null) out.push(`\x1b[${this.frameTopAbs};1H`);
    else if (this.prevCursorRow > 0) out.push(`\x1b[${this.prevCursorRow}A`);
    out.push("\r\x1b[J");
    out.push(text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").join("\r\n"));
    out.push("\r\n");
    this.output.write(out.join(""));
    this.invalidateAnchor();
    if (wasSuspended) this.frameSuspended = true;
    else this.render();
  }
```
В `onKey` первой строкой после `isDone`:
```ts
    if (!this.inputEnabled) {
      // Во время стрима разрешаем только прерывание (Ctrl+C / Esc).
      const k = key as { name?: string; ctrl?: boolean };
      if (k?.ctrl && k.name === "c") this.ctrlC();
      return;
    }
```
В `render()` первой строкой: `if (this.frameSuspended) return;`.

- [x] **Step 4: Возврат DSR-якоря с таймаутом и opt-out**

Заменить закомментированный блок в конце `render()`; `prevCursorRow = idx` перенести **до** DSR-блока:
```ts
    this.prevCursorRow = idx;
    if (this.frameTopAbs !== null) {
      const H = this.screenRows();
      if (H) {
        const L = layout.length;
        if (this.frameTopAbs + L - 1 > H) this.frameTopAbs = H - L + 1;
      }
    } else if (!this.dsrPending && process.env.MMA_DSR !== "0") {
      this.dsrPending = true;
      this.output.write("\x1b[6n");
      if (this.dsrTimer) clearTimeout(this.dsrTimer);
      this.dsrTimer = setTimeout(() => {
        this.dsrPending = false;
        this.dsrTimer = null;
      }, 150);
    }
```
В `invalidateAnchor()` и `close()` очищать `dsrTimer`.

- [x] **Step 5: Существующие тесты**

`tests/ui/line-editor-interactive.test.ts` и `tests/ui/line-editor.test.ts` ассертят точные ANSI-байты **без** `\x1b[6n`. Выставить `process.env.MMA_DSR = "0"` в `beforeEach` этих файлов (и удалять в `afterEach`), либо обновить ожидания. Тест якоря (`line-editor.test.ts:295-397`) — проверить, что DSR-парсинг по-прежнему работает при явном `\x1b[6n`.

- [x] **Step 6: Прогнать** → `bun test tests/ui/line-editor.test.ts tests/ui/line-editor-interactive.test.ts && tsc --noEmit`
- [x] **Step 7: Commit** — `feat(ui): printAbove, frame suspend, input gating and DSR fallback`

---

## Task 5: Logger → OutputBus

**Files:** Modify `src/logger/app-logger.ts`; Test `tests/logger.test.ts`, `tests/output/logger-bus.test.ts`.

- [x] **Step 1: Тест** `tests/output/logger-bus.test.ts` (эмит с source=prefix, фильтр уровня, `logSilent`/`logStructured` не эмитят).
- [x] **Step 2: Упадёт**
- [x] **Step 3: Реализовать** (из «Интерфейсы»): конструктор `(level, prefix, sink: OutputSink = defaultOutputBus)`, `log()` → `this.sink.emit({level, source: this.prefix||"mma", kind:"log", text})`, `child()` пробрасывает sink, удалить `console.log`/`LEVEL_COLORS`/`isColorEnabled`.
- [x] **Step 4: Обновить `tests/logger.test.ts`** — перехват через `OutputBus`, а не `console.log`; проверить `app.jsonl`/`.log` как раньше.
- [x] **Step 5: Прогнать** → PASS + typecheck.
- [x] **Step 6: Commit** — `refactor(logger): emit OutputEvents instead of console.log`

---

## Task 6: Renderer и Spinner → OutputChannel (streaming + overlay)

**Files:** Modify `src/ui/renderer.ts`, `src/ui/spinner.ts`, `src/ui/output.ts`, `src/ui/md-formatter.ts`; Test `tests/ui/renderer.test.ts`, `tests/renderer.test.ts`, `tests/ui/spinner.test.ts`.

- [x] **Step 1: Spinner — overlay**

Заменить `stream` на `channel`:
```ts
import type { OutputChannel } from "../output/channel";
export interface SpinnerOptions { enabled?: boolean; channel?: OutputChannel; intervalMs?: number; width?: number; }
```
`stop()` → `this.channel?.writeOverlay("\r\x1b[K")`; `tick()` → `this.channel?.writeOverlay("\r" + pc.cyan(frame) + " " + this.message + "\x1b[K")`. Если `channel` нет — писать в `process.stderr` как раньше (тесты/standalone).

- [x] **Step 2: Renderer — канал**

`RendererOptions` — убрать `out`/`err`, добавить `channel?: OutputChannel`; дефолт `getDefaultChannel()`. `new Spinner({..., channel: this.channel})`. `FormattingStream`:
```ts
    this.fmt = new FormattingStream(
      (line) => this.channel.writeRaw(`${line}\n`),
      this.width,
      (text) => this.channel.writeRaw(text),
    );
```
Заменить все `this.out.write` → `this.channel.writeRaw(...)`, `this.err.write` → `this.channel.writeRaw(..., "stderr")`.

- [x] **Step 3: md-formatter — flush-guard**

`FormattingStream` держит незакрытую частичную строку и `\x1b[ND` rewind. Канал уже закрывает partial перед `log` в streaming-режиме, но markdown-таблица при `flushTable`/`emitCodeBlock` печатается построчно. Добавить в `FormattingStream` метод `hasPartial(): boolean` и `flushPartialNow()` (эмитит rewind + текущий буфер через `onRawWrite`, сбрасывает `partialWritten`) — Renderer вызовет его перед `toolStart`/`toolEnd`/`error`, чтобы событие не вклинилось в незавершённый markdown-абзац.

- [x] **Step 4: `src/ui/output.ts` — через шину**

`writeOutput/writeError/writeSuccess/writeWarning` эмитят `kind:"raw"`/`kind:"log"` в `defaultOutputBus` (deprecated-обёртки сохранить).

- [x] **Step 5: Обновить тесты**

`tests/ui/spinner.test.ts` — fake `OutputChannel` (`writeOverlay` собирает). `tests/ui/renderer.test.ts`/`tests/renderer.test.ts` — передавать `channel` с fake streams; проверить plain-режим, карточки, footer, error-стрим (stderr), отсутствие спиннера для `question`/`approve`, `hasPartial`-guard перед `toolStart`.

- [x] **Step 6: Прогнать** → `bun test tests/ui/renderer.test.ts tests/renderer.test.ts tests/ui/spinner.test.ts tests/md-formatter.test.ts && tsc --noEmit`
- [x] **Step 7: Commit** — `refactor(ui): route Renderer/Spinner/markdown through OutputChannel`

---

## Task 7: REPL — владение терминалом, баннеры, пробы

**Files:** Modify `src/cli/repl.ts`, `src/cli/repl-commands.ts`; Test `tests/cli/*`.

- [x] **Step 1: Проводка канала/PromptSink**

```ts
import { getDefaultChannel, type OutputChannel, type PromptSink } from "../output";
```
Поля `private output: OutputChannel; private promptSink: PromptSink;` (опциональный параметр конструктора `output` для тестов).
```ts
    this.output = output ?? getDefaultChannel();
    this.promptSink = {
      isActive: () => this.rl instanceof LineEditor && !this.agentRunning && !this.inputLocked,
      printAbove: (text) => {
        if (this.rl instanceof LineEditor) this.rl.printAbove(text);
        else process.stdout.write(`${text}\n`);
      },
    };
    this.output.attachPrompt(this.promptSink);
```

- [x] **Step 2: `runAgent` — явный streaming-lifecycle**

Заменить (`repl.ts:508-512`):
```ts
    if (this.rl instanceof LineEditor) {
      this.rl.suspendFrame();
      this.rl.setInputEnabled(false);
    }
    this.output.beginStreaming();
    this.output.writeLine(`\r${divider()}\n${pc.green(t("repl.agent"))}`);
```
В `finally` (после `agentRunning = false`):
```ts
      this.output.endStreaming();
      if (this.rl instanceof LineEditor) {
        this.rl.setInputEnabled(true);
        this.rl.resumeFrame();
      }
```
`Renderer` создавать с `{ spinner, baseDir, channel: this.output }`. Убрать прямые `process.stdout.write` (`:512,:556,:569`) — через `this.output.writeLine`. `renderer.footer` оставить (пишет через канал).

- [x] **Step 3: Баннеры/справка/контекст/ошибки** — все `console.log/error` и `process.stdout.write` в `repl.ts` (`:420,:445,:466,:472,:564,:569,:611,:618-624,:645-704,:809-822`) → `this.output.writeLine(...)` / `writeLine(..., "stderr")`.

- [x] **Step 4: Фоновые баннеры (LSP/context/health)**

`repl.ts:832` → `this.output.writeLine(\`${divider()}\n${line}\`)`; `:885` → то же; `:859` `writeWarning(...)` → `this.output.writeLine(line)`. Канал сам напечатает над prompt, если он активен, и не тронет кадр иначе. `this.rl.prompt()` после них не нужен.

- [x] **Step 5: `repl-commands.ts`**

Добавить `output: OutputChannel` в `ReplContext`; все `console.log` (~90 мест) → `ctx.output.writeLine(...)`. Для «модальных» команд (`/wizard`, `/resume`, `/model` wizard) оборачивать в `beginModal()/endModal()`.

- [x] **Step 6: Прогнать** → `bun test tests/cli tests/ui && tsc --noEmit`
- [x] **Step 7: Commit** — `refactor(repl): explicit terminal ownership via OutputChannel`

---

## Task 8: Интерактивные тулы через PromptIO (устранить второй readline)

**Files:** Create `src/tools/prompt-io.ts`; Modify `src/tools/{types,question,approve,user-input}.ts`, `src/core/bootstrap.ts`, `src/cli/repl.ts`; Test `tests/tools/prompt-io.test.ts`.

- [x] **Step 1: Тест** `tests/tools/prompt-io.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { createPromptIO } from "../../src/tools/prompt-io";

describe("createPromptIO", () => {
  it("delegates to the injected LineEditor-like asker and formats a choice", async () => {
    const calls: string[] = [];
    const io = createPromptIO({
      ask: async (q) => {
        calls.push(q);
        return "2";
      },
      print: (l) => calls.push(`print:${l}`),
    });
    const answer = await io.askChoice({
      message: "Pick",
      options: [
        { label: "one", value: "a" },
        { label: "two", value: "b" },
      ],
    });
    expect(answer).toBe("b");
    expect(calls.some((c) => c.startsWith("print:"))).toBe(true);
  });
});
```

- [x] **Step 2: Упадёт**
- [x] **Step 3: Реализовать `prompt-io.ts`**

`createPromptIO({ ask, print })` возвращает `PromptIO`: `askText` возвращает ответ; `askChoice` печатает меню через `print` и парсит номер/значение (переиспользовать `formatMenu`/`parseSelection` из `user-input.ts`, экспортировать их).
- [x] **Step 4: Прокинуть PromptIO в ToolContext**

`src/tools/types.ts` — `promptIO?: PromptIO`. `bootstrap.ts` — `toolCtx.promptIO` формируется как fallback (`createPromptIO` поверх `user-input.ts` + `getDefaultChannel().writeLine`), а `Repl` **перезаписывает** его при старте на `LineEditor`-версию:
```ts
    const io = createPromptIO({
      ask: (q) => new Promise((res) => this.rl.question(q, res)),
      print: (l) => this.output.writeLine(l),
    });
    // ToolContext живёт в bootstrap; REPL выставляет promptIO через toolExecutor.
```
В `question.ts`/`approve.ts` вызывать `ctx.promptIO` если он есть и интерактивен, иначе текущий `user-input` fallback. Перед `askChoice` — `output.beginModal()` (через `promptIO` или `ToolContext.output`), после — `endModal()`.
- [x] **Step 5: `user-input.ts`** — `console.log` меню → `getDefaultChannel().writeLine`; остаётся fallback для неинтерактивного режима.
- [x] **Step 6: Прогнать** → `bun test tests/tools tests/cli && tsc --noEmit`
- [x] **Step 7: Commit** — `refactor(tools): interactive prompts via PromptIO, no competing readline`

---

## Task 9: Wizard до bootstrap

**Files:** Modify `src/cli/main.ts`; Create `src/cli/setup-order.ts`; Test `tests/cli/main-first-run.test.ts`.

- [x] **Step 1: Тест** порядка (`setup` → `bootstrap`, и пропуск при наличии конфига) — код из v1-плана, но `order` принимает `runSetup`/`applyAnswers`/`bootstrap`.
- [x] **Step 2: `src/cli/setup-order.ts`** — чистая функция упорядочивания.
- [x] **Step 3: Переписать first-run в `main.ts`** — как в v1-плане: `loadConfig` → применить ответы → `saveConfig` → `bootstrap` → `Repl` → `start`. `runSetup()` без `repl.rl` (свой readline; reset в `setup.ts:235-248` уже есть).
- [x] **Step 4: Прогнать** → `bun test tests/cli/main-first-run.test.ts && tsc --noEmit`
- [x] **Step 5: Ручная проверка first-run** (песочница + пустой `MMA_CONFIG_DIR`): паузы > 5с между ответами; пробы не вклиниваются; промпты не дублируются.
- [x] **Step 6: Commit** — `refactor(cli): run setup wizard before bootstrap`

---

## Task 10: Фоновые пробы — silent; один пользовательский путь

**Files:** Modify `src/core/bootstrap.ts`; Test `tests/core/*`.

- [x] **Step 1: `bootstrap.ts`** — context probe (`:327-335`) и reasoning probe (`:379`) → `logger.logSilent("warn"|"info", ...)`. UI-строку рисует только REPL через канал (Task 7 Step 4).
- [x] **Step 2: Проверить отсутствие двойного вывода** — `SessionLogger.appendLog` для `context_probe` оставить (машинная запись), но не логировать то же через `logger` (кроме `logSilent`).
- [x] **Step 3: Прогнать** → `bun test tests/core tests/llm && tsc --noEmit`
- [x] **Step 4: Commit** — `refactor(bootstrap): background probes log silently`

---

## Task 11: Полный свип прямых записей

**Files:** все из таблицы ниже. Тест-отчёт создаётся в Task 13.

| Файл | Замена |
|---|---|
| `src/index.ts:64` | `defaultOutputBus.log("info","mma", t(...))` |
| `src/config/config.ts:89,264,270,330,379`, `domains.ts:107` | `defaultOutputBus.log("warn"/"error"/"info","config",...)` |
| `src/cli/commands.ts` (все `console.log`) | `getDefaultChannel().writeLine(...)`; `:108` (`config show` JSON) → `writeMachineJson(config)` |
| `src/cli/run-result.ts:30,35,38,42,45,49` | `channel.writeLine(...)`, ошибка → `writeLine(..., "stderr")` |
| `src/cli/security-commands.ts`, `plugin-commands.ts` | `channel.writeLine(...)` |
| `src/cli/setup.ts:38,136-279` | `channel.writeLine(...)`; канал `getDefaultChannel()` + `beginModal()` на время wizard |
| `src/tools/user-input.ts:112,119` | `channel.writeLine(...)` (Task 8) |
| `src/modules/certification/cli.ts` (~25) | `channel.writeLine(...)` |
| `src/modules/mcp/client.ts:135` | `logger.logSilent("error", ...)` (не allowlist — это диагностика) |
| `src/modules/mcp/module.ts` | `ctx.logger` уже через шину; direct-writes нет |
| `src/modules/security/session-encryption.ts:126` | `logger.logSilent("error", ...)` |
| `src/modules/security/audit-notifier.ts:209,261,314,326,353` | `logger.logSilent("error", ...)` |
| `src/modules/updater/module.ts:43,44` + `main.ts:30-32` | `defaultOutputBus.log(...)` через адаптер канала |
| `src/cli/main.ts:91,105,242,280` | `getDefaultChannel().writeLine(...)`; `:280` fatal → `writeLine(..., "stderr")` |
| `src/cli/main.ts:119-148` (`--json`) | `writeMachineJson(...)` |
| `src/tools/subagent.ts`, `src/core/agent-moe.ts`, `moe-executor.ts`, `plan-store.ts` | прямых записей нет — проверить guard-тестом |
| `examples/plugins/*/plugin.ts:120/124/163/167` | `ctx.logger` уже через шину |

- [x] **Step 1: Провести замены по таблице.**
- [x] **Step 2: `tsc --noEmit`** → PASS.
- [x] **Step 3: Commit** — `refactor: migrate all direct terminal writes to OutputBus/Channel`

---

## Task 12: Мульти-поверхность — JSON, session, плагины

**Files:** Create `src/output/{json-sink,session-sink,plugin-bridge}.ts`; Modify `src/cli/main.ts`, `src/modules/types.ts`, `src/modules/plugins/manager.ts`, `src/cli/repl.ts`, `examples/plugins/web-ui/*`, `examples/plugins/trace-server/*`; Test `tests/output/json-sink.test.ts`.

- [x] **Step 1: `json-sink.ts` + тест** — собирает `warn/error` для `--json`.
- [x] **Step 2: `main.ts --json`** — `channel.setQuiet(true)` + `new JsonOutputSink(bus)`; в JSON-результат добавить `diagnostics`. Человеческий лог в stdout не попадает (закрывает баг «лог портит JSON»).
- [x] **Step 3: `session-sink.ts`** — события с `data.persist === true` пишет в `SessionLogger` (файл), не дублируя существующие `log*`.
- [x] **Step 4: Плагинная поверхность — `HostBridge.subscribeOutput`**

`src/modules/types.ts`:
```ts
export interface HostBridge {
  isBusy(): boolean;
  submit(text: string, opts?: { images?: string[] }): Promise<unknown>;
  interrupt(): void;
  /** Подписка на события вывода (логи, пробы, баннеры). Возвращает отписку. */
  subscribeOutput(fn: (ev: OutputEvent) => void): () => void;
}
```
`createHostBridge` (`repl.ts:70`) реализует через `defaultOutputBus.subscribe`. `PluginManager.withHost` уже мержит `hostBridge` в ctx — плагины получают `ctx.hostBridge.subscribeOutput`.
- [x] **Step 5: web-ui**

В `examples/plugins/web-ui/plugin.ts` `onSessionStart` подписаться:
```ts
    ctx.hostBridge?.subscribeOutput?.((ev) => {
      if (ev.kind === "log" && (ev.level === "warn" || ev.level === "error")) {
        state.broadcast("output", { level: ev.level, source: ev.source, text: ev.text });
      }
    });
```
`state.broadcast` (`state.ts:90-104`) уже фан-аутит SSE. Существующие агент-хуки (`onText`/`onToolStart`/…) оставить — они несут структурированные данные; шина добавляет то, что раньше уходило в терминал. Тест `tests/web-ui-server.test.ts` продолжает проходить.
- [x] **Step 6: trace-server** — аналогичная подписка в `plugin.ts` (`onSessionStart`), broadcast через `state.ts:103-112`.
- [x] **Step 7: Прогнать** → `bun test tests/output tests/web-ui-server.test.ts tests/modules/plugin-host-bridge.test.ts && tsc --noEmit`
- [x] **Step 8: Commit** — `feat(output): JSON/session subscribers and plugin output bus`

---

## Task 13: Guard-тест против прямых записей

**Files:** Create `tests/output/no-direct-console.test.ts`.

- [x] **Step 1: Тест** — обход `src/**` и `examples/**`; allowlist:

```ts
const ALLOWLIST = new Set([
  "src/output/channel.ts",              // единственный терминальный писатель
  "src/output/machine.ts",              // JSON-контракты CLI
  "src/core/crash-handler.ts",          // аварийный путь
  "src/modules/browser/bridge-server.mjs", // NDJSON протокол дочернего процесса
]);
const FORBIDDEN = /\bconsole\.(log|warn|error|info|debug)\b|process\.(stdout|stderr)\.write\b/;
```

- [x] **Step 2: Прогнать — добить остаток** (`bun test tests/output/no-direct-console.test.ts`), домигрировать, для машинных контрактов — добавить в allowlist с комментарием.
- [x] **Step 3: PASS** + Commit — `test(output): guard against direct console/stdout writes`

---

## Task 14: Документация, AGENTS.md, версия

**Files:** `CHANGELOG.md`, `package.json`, `AGENTS.md`, `docs/agents/architecture.md`.

- [x] **Step 1: CHANGELOG** `## [1.0.0] - 2026-09-18` (Added/Changed/Removed).
- [x] **Step 2: `package.json` → `1.0.0`**.
- [x] **Step 3: AGENTS.md** — раздел «Output Architecture» (инварианты владения, режимы, `printAbove`, guard) + «Current Version: 1.0.0». `docs/agents/architecture.md` — модуль `src/output/`.
- [x] **Step 4: i18n** — убедиться, что все ключи из аудита сохранены; `tests/i18n.test.ts` зелёный; новых output-ключей не требуется.
- [x] **Step 5: Commit** — `docs: output architecture; release 1.0.0`

---

## Task 15: Финальная верификация

- [x] **Step 1: Полный прогон** → `bun test && tsc --noEmit && bun run format:check`
- [x] **Step 2: Repro исходного бага** — first-run с паузами > 5с: пробы не вклиниваются, промпты не дублируются, контекстная строка один раз.
- [x] **Step 3: Стриминг** — в REPL запустить длинный ответ и во время генерации печатать в поле ввода: ввод не рисуется поверх стрима; `question`/`approve` открывают prompt без второго readline; после ответа стрим продолжается.
- [x] **Step 4: Лог во время стрима** — спровоцировать `logger.warn` (например, `/provider list` + health probe) mid-stream: строка не разрывает markdown, появляется на новой строке.
- [x] **Step 5: `--json`** — валидный JSON, `diagnostics`, без человеческих `[INFO]` в stdout.
- [x] **Step 6: Плагины** — web-ui: SSE `output`-события приходят; существующие `/api/*` работают (`tests/web-ui-server.test.ts`).
- [x] **Step 7: Итог** — `git status` чистый; PR/merge по решению заказчика.

---

## Риски и митигации

| Риск | Митигация |
|---|---|
| Несколько `OutputChannel` → дубли вывода | singleton `getDefaultChannel()`; тест на идентичность; `dispose()` в тестах |
| DSR на ConPTY завешивает stdout | `MMA_DSR=0`, таймаут 150мс, относительный fallback; ручная проверка на Windows |
| Частичный markdown теряется/дублируется | `hasPartial()`/`flushPartialNow()` в `FormattingStream`; `closePartial()` перед `log` в streaming; тесты |
| Ввод рисует поверх стрима | `setInputEnabled(false)` + `suspendFrame()`; проверка в Task 15 Step 3 |
| Спиннер стирает prompt | `writeOverlay` no-op при активном prompt; спиннер живёт только в streaming |
| Второй readline в `question`/`approve` | `PromptIO` + `beginModal()`; fallback только для неинтерактивного режима |
| Лог портит `--json` | `setQuiet(true)` + `JsonOutputSink` |
| Плагины ломаются от нового ctx | `subscribeOutput` аддитивен; существующие хуки и `tests/web-ui-server.test.ts` сохранены |
| Guard-тест ловит легальные stdout-контракты | allowlist: channel/machine/crash/bridge |

---

## Самопроверка плана

- **Полнота:** матрица полноты покрывает каждую поверхность из аудита (Logger, Renderer×2, Spinner, markdown rewind, ручные ANSI, prompt-vs-stream, 3 stdin-конкурента, bootstrap-пробы, CLI/REPL/setup/config/cert/security/MCP/updater, `--json`, plugin HostBridge, web-ui/trace-server, i18n, DSR, singleton-дубли).
- **Плейсхолдеров нет:** код новых модулей приведён; для миграций даны точные файл→замена и guard-тест, добивающий остаток.
- **Согласованность:** `OutputEvent`/`PromptSink`/`ChannelMode`/`PromptIO`/`printAbove`/`subscribeOutput` используются одинаково во всех задачах; `formatEventLine` определён в Task 2 и используется в Task 3.
