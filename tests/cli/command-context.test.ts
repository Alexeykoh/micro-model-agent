import { describe, it, expect } from "vitest";
import { Readable } from "stream";
import {
  createCommandInput,
  type CommandInput,
  type CommandOutput,
} from "../../src/cli/command-context";
import type { LineInput } from "../../src/ui/line-editor";

/**
 * Контракты фронтендового ввода/вывода команд — тот шов, ради которого
 * `ReplContext` (20 членов, `rl: LineInput` + `output: OutputChannel`) был
 * разделён на `CommandServices` + `CommandIO`.
 *
 * Смысл тестов: новый фронтенд (TUI) реализует ТОЛЬКО `CommandOutput` (3+1
 * метода) и `CommandInput` (3 метода) — и получает весь реестр команд.
 * Ничего из этого не должно требовать терминала, stdout или readline.
 */

class FakeRline extends Readable {
  isTTY = true;
  _read(): void {}
}

/** Минимальный `LineInput` — адаптеру он нужен только для `withInput`. */
function makeLineInput(): LineInput {
  return new FakeRline() as unknown as LineInput;
}

/** Фронтенд без терминала: накопитель строк вместо `OutputChannel`. */
function makeBufferingOutput(): CommandOutput & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    writeLine(text) {
      lines.push(text);
    },
    clearScreen() {
      lines.push("<clear>");
    },
  };
}

describe("CommandOutput — минимальная поверхность фронтенда", () => {
  it("требует только writeLine и clearScreen (остальное опционально)", () => {
    const out = makeBufferingOutput();
    out.writeLine("hello");
    out.writeLine("warn", "stderr");
    out.clearScreen();
    expect(out.lines).toEqual(["hello", "warn", "<clear>"]);
  });

  it("живёт без терминала: реализация без канала/оверлея валидна по типу", () => {
    // Компилируется ⇒ TUI-подобный вывод не обязан иметь OutputChannel.
    const out: CommandOutput = makeBufferingOutput();
    out.setSuppressInfoLogs?.(true);
    out.setShowDiagnostics?.(true);
    out.writeOverlay?.("\r…");
    expect(typeof out.writeLine).toBe("function");
  });
});

describe("CommandInput — адаптер терминала", () => {
  it("question идёт в переданный ask, confirm разбирает yes/no", async () => {
    const seen: string[] = [];
    const input: CommandInput = createCommandInput(
      makeLineInput(),
      async (prompt) => {
        seen.push(prompt);
        return "y";
      },
      (fn) => fn(),
    );

    expect(await input.question("Продолжить? ")).toBe("y");
    expect(await input.confirm("Сбросить всё? ")).toBe(true);
    expect(seen).toEqual(["Продолжить? ", "Сбросить всё? "]);
  });

  it("confirm отклоняет не-yes ответ", async () => {
    const input = createCommandInput(makeLineInput(), async () => "nope", (fn) => fn());
    expect(await input.confirm("Удалить? ")).toBe(false);
  });

  it("withInput отдаёт prompt-источник и держит владение вводом", async () => {
    const order: string[] = [];
    const rl = makeLineInput();
    const input = createCommandInput(
      rl,
      async () => "unused",
      async (fn) => {
        order.push("enter-exclusive");
        const r = await fn();
        order.push("exit-exclusive");
        return r;
      },
    );

    const got = await input.withInput(async (prompt) => {
      order.push("wizard-running");
      expect(prompt).toBe(rl);
      return "answers";
    });

    expect(got).toBe("answers");
    // Владение вводом охватывает весь диалог визарда, а не отдельный вопрос.
    expect(order).toEqual(["enter-exclusive", "wizard-running", "exit-exclusive"]);
  });

  it("withInput освобождает владение даже при ошибке диалога", async () => {
    const order: string[] = [];
    const input = createCommandInput(
      makeLineInput(),
      async () => "unused",
      async (fn) => {
        order.push("enter");
        try {
          return await fn();
        } finally {
          order.push("exit");
        }
      },
    );

    await expect(
      input.withInput(async () => {
        throw new Error("wizard failed");
      }),
    ).rejects.toThrow("wizard failed");
    expect(order).toEqual(["enter", "exit"]);
  });
});