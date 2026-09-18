import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable } from "stream";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Repl } from "../../src/cli/repl";
import { LineEditor } from "../../src/ui/line-editor";
import { t } from "../../src/i18n/index";
import { makeCaptureChannel, type CaptureChannel } from "./capture-channel";

class FakeInput extends Readable {
  isTTY = true;
  _read(): void {}
  pushData(data: string | Buffer): void {
    this.push(typeof data === "string" ? Buffer.from(data, "utf8") : data);
  }
}

class FakeOutput {
  data = "";
  columns = 80;
  write(s: string): boolean {
    this.data += s;
    return true;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function makeEditor() {
  const input = new FakeInput();
  const output = new FakeOutput();
  const editor = new LineEditor({
    input: input as never,
    output: output as never,
    prompt: "> ",
  });
  return { editor, input, output };
}

function makeAgent(overrides?: Record<string, unknown>) {
  return {
    run: async () => ({
      success: true,
      text: "ok",
      provider: "p",
      model: "m",
      durationMs: 1,
    }),
    shutdown: () => {},
    getProviderFor: () => undefined,
    ...overrides,
  } as never;
}

function makeConfig() {
  return {
    model: "test",
    provider: { type: "test", baseUrl: "test", apiKey: "test" },
    contextWindow: 32768,
    contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
    logLevel: "info",
    locale: "en",
    maxToolIterations: 25,
    stuckThreshold: 8,
    autoPlan: true,
    showReasoning: false,
    ui: {},
    session: { autoSave: false, maxSessions: 50, isolateMemory: false },
  } as never;
}

describe("REPL terminal ownership", () => {
  let dir: string;
  let historyPath: string;
  let originalRl: { close?: () => void } | undefined;
  let editors: LineEditor[] = [];
  let captures: CaptureChannel[] = [];

  beforeEach(() => {
    process.env.MMA_DSR = "0";
    dir = mkdtempSync(join(tmpdir(), "mma-repl-ownership-"));
    historyPath = join(dir, "repl-history");
    editors = [];
    captures = [];
  });

  afterEach(() => {
    for (const editor of editors) editor.close();
    for (const capture of captures) capture.channel.dispose();
    originalRl?.close?.();
    originalRl = undefined;
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MMA_DSR;
  });

  function makeRepl(agent = makeAgent()): { repl: Repl; capture: CaptureChannel } {
    const capture = makeCaptureChannel();
    captures.push(capture);
    const repl = new Repl(
      agent as never,
      makeConfig(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      historyPath,
      undefined,
      undefined,
      capture.channel,
    );
    originalRl = repl.rl as unknown as { close?: () => void };
    return { repl, capture };
  }

  function attachEditor(repl: Repl): LineEditor {
    const { editor } = makeEditor();
    editors.push(editor);
    repl.rl = editor;
    return editor;
  }

  it("runAgent suspends the editor, disables input, then resumes and re-enables", async () => {
    const { repl } = makeRepl();
    const editor = attachEditor(repl);
    const suspend = vi.spyOn(editor, "suspendFrame");
    const resume = vi.spyOn(editor, "resumeFrame");
    const setInput = vi.spyOn(editor, "setInputEnabled");

    await repl.runAgent("hello");

    expect(suspend).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(setInput).toHaveBeenCalledWith(false);
    expect(setInput).toHaveBeenCalledWith(true);
    expect(suspend.mock.invocationCallOrder[0]).toBeLessThan(resume.mock.invocationCallOrder[0]);
  });

  it("writes the Agent label without an extra blank line before the answer", async () => {
    const { repl, capture } = makeRepl(
      makeAgent({
        run: async (_input: string, onText: (s: string) => void) => {
          onText("hello");
          return { success: true, text: "hello" };
        },
      }),
    );
    attachEditor(repl);

    await repl.runAgent("hi");

    const label = t("repl.agent");
    expect(capture.out.data).toContain(`${label}\n- `);
    expect(capture.out.data).not.toContain(`${label}\n\n`);
  });

  it("swallows printable keypresses while a run is in flight", async () => {
    let resolveRun: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveRun = resolve;
    });
    const { repl } = makeRepl(makeAgent({ run: () => pending }));
    const editor = attachEditor(repl);
    const input = editor.input as unknown as FakeInput;
    const lines: string[] = [];
    editor.on("line", (l) => lines.push(l ?? ""));

    const runPromise = repl.runAgent("hello");
    await tick(); // let runAgent reach setInputEnabled(false)

    input.pushData("abc\r");
    await tick();
    expect(lines).toEqual([]);

    resolveRun({ success: true, text: "ok" });
    await runPromise;
  });

  it("queues channel events during withExclusiveInput and flushes them on endModal", async () => {
    const { repl, capture } = makeRepl();

    await repl.withExclusiveInput(async () => {
      capture.channel.writeLine("during-modal");
      expect(capture.out.data).toBe("");
    });

    expect(capture.out.data).toContain("during-modal");
  });

  it("presents the prompt exactly once for a command that runs the agent (/run)", async () => {
    const { repl } = makeRepl();
    const editor = attachEditor(repl);
    (repl as unknown as { running: boolean }).running = true;
    const present = vi.spyOn(repl as unknown as { presentPrompt: () => void }, "presentPrompt");
    const resume = vi.spyOn(editor, "resumeFrame");

    repl.registerCommand({
      name: "run",
      description: "run",
      action: async () => {
        await repl.runAgent("hi");
      },
    });

    await (repl as unknown as { executeCommand: (s: string) => Promise<void> }).executeCommand(
      "/run hi",
    );
    (repl as unknown as { afterCommand: () => void }).afterCommand();

    expect(resume).toHaveBeenCalledTimes(1);
    expect(present).not.toHaveBeenCalled();
  });

  it("presents the prompt once for a command that does not run the agent", async () => {
    const { repl } = makeRepl();
    attachEditor(repl);
    (repl as unknown as { running: boolean }).running = true;
    const present = vi.spyOn(repl as unknown as { presentPrompt: () => void }, "presentPrompt");

    repl.registerCommand({ name: "noop", description: "noop", action: () => {} });
    await (repl as unknown as { executeCommand: (s: string) => Promise<void> }).executeCommand(
      "/noop",
    );
    (repl as unknown as { afterCommand: () => void }).afterCommand();

    expect(present).toHaveBeenCalledTimes(1);
  });
});
