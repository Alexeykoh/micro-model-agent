// A12: REPL отдаёт модели текст как набран — без срезания отступов и пустых строк.
import { describe, expect, it } from "vitest";
import { LineDispatcher, type LineDispatchHost } from "../../src/cli/line-dispatch";

interface Recorder {
  host: LineDispatchHost;
  agentInputs: string[];
  commands: string[];
}

function makeHost(openFence: boolean): Recorder {
  const agentInputs: string[] = [];
  const commands: string[] = [];
  const host: LineDispatchHost = {
    isBusy: () => false,
    remember: () => {},
    executeCommand: async (line) => {
      commands.push(line);
    },
    afterCommand: () => {},
    runAgent: async (input) => {
      agentInputs.push(input);
    },
    // Многострочный режим: незакрытый ``` держит ввод открытым.
    isMultiLineInput: (text) => openFence && (text.match(/```/g)?.length ?? 0) % 2 === 1,
    promptContinuation: () => {},
    promptIdle: () => {},
  };
  return { host, agentInputs, commands };
}

describe("LineDispatcher — многострочный ввод", () => {
  it("однострочный ввод с отступом не срезается", async () => {
    const rec = makeHost(false);
    const d = new LineDispatcher(rec.host);
    d.onLine("  отступ важный");
    await d.idle();
    expect(rec.agentInputs).toEqual(["  отступ важный"]);
  });

  it("многострочный блок уходит как набран: отступы и пустые строки", async () => {
    const rec = makeHost(true);
    const d = new LineDispatcher(rec.host);
    d.onLine("  ```ts");
    d.onLine("  const a = 1;");
    d.onLine("");
    d.onLine("  const b = 2;");
    d.onLine("  ```");
    await d.idle();
    expect(rec.agentInputs).toEqual(["  ```ts\n  const a = 1;\n\n  const b = 2;\n  ```"]);
  });

  it("многострочная слэш-команда всё равно распознаётся", async () => {
    const rec = makeHost(true);
    const d = new LineDispatcher(rec.host);
    d.onLine("/plan create ```");
    d.onLine("шаг");
    d.onLine("```");
    await d.idle();
    expect(rec.agentInputs).toEqual([]);
    expect(rec.commands.length).toBe(1);
    expect(rec.commands[0]).toBe("/plan create ```\nшаг\n```");
  });
});
