import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable } from "stream";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Repl } from "../../src/cli/repl";
import { LineEditor } from "../../src/ui/line-editor";
import type { PromptIO } from "../../src/tools/prompt-io";
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
    run: async () => ({ success: true, text: "ok" }),
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

describe("REPL PromptIO", () => {
  let dir: string;
  let historyPath: string;
  let editors: LineEditor[] = [];
  let captures: CaptureChannel[] = [];
  let originalRl: { close?: () => void } | undefined;

  beforeEach(() => {
    process.env.MMA_DSR = "0";
    dir = mkdtempSync(join(tmpdir(), "mma-repl-promptio-"));
    historyPath = join(dir, "repl-history");
    editors = [];
    captures = [];
    originalRl = undefined;
  });

  afterEach(() => {
    for (const editor of editors) editor.close();
    for (const capture of captures) capture.channel.dispose();
    // Close the constructor-created rl before removing its history dir, so no
    // orphaned close handler tries to save history after teardown.
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

  it("installs a PromptIO on the agent during construction", () => {
    let installed: PromptIO | undefined;
    makeRepl(
      makeAgent({
        setPromptIO: (io: PromptIO) => {
          installed = io;
        },
      }),
    );
    expect(installed).toBeTruthy();
    expect(typeof installed!.askText).toBe("function");
    expect(typeof installed!.askChoice).toBe("function");
  });

  it("takes the terminal for a question and restores the streaming state", async () => {
    let installed: PromptIO | undefined;
    const { repl, capture } = makeRepl(
      makeAgent({
        setPromptIO: (io: PromptIO) => {
          installed = io;
        },
      }),
    );
    const editor = attachEditor(repl);
    // Mirror the mid-run state the tool actually encounters: the frame is
    // suspended and input is disabled by runAgent.
    editor.suspendFrame();
    editor.setInputEnabled(false);
    const question = vi
      .spyOn(editor, "question")
      .mockImplementation((_query: string, cb: (answer: string) => void) => cb("  hi  "));
    const enable = vi.spyOn(editor, "setInputEnabled");
    const resume = vi.spyOn(editor, "resumeFrame");
    const suspend = vi.spyOn(editor, "suspendFrame");
    const beginModal = vi.spyOn(capture.channel, "beginModal");
    const endModal = vi.spyOn(capture.channel, "endModal");

    const answer = await installed!.askText("Name?");

    expect(answer).toBe("hi");
    expect(question).toHaveBeenCalledTimes(1);
    expect(beginModal).toHaveBeenCalledTimes(1);
    expect(endModal).toHaveBeenCalledTimes(1);
    expect(enable).toHaveBeenCalledWith(true);
    expect(enable).toHaveBeenCalledWith(false);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(suspend).toHaveBeenCalledTimes(1);
    // Terminal is borrowed before touching editor/channel state and restored
    // only after the frame is suspended again.
    expect(beginModal.mock.invocationCallOrder[0]).toBeLessThan(
      question.mock.invocationCallOrder[0],
    );
    expect(question.mock.invocationCallOrder[0]).toBeLessThan(suspend.mock.invocationCallOrder[0]);
    expect(suspend.mock.invocationCallOrder[0]).toBeLessThan(endModal.mock.invocationCallOrder[0]);
  });

  it("routes the rendered menu through the output channel", async () => {
    let installed: PromptIO | undefined;
    const { repl, capture } = makeRepl(
      makeAgent({
        setPromptIO: (io: PromptIO) => {
          installed = io;
        },
      }),
    );
    const editor = attachEditor(repl);
    vi.spyOn(editor, "question").mockImplementation(
      (_query: string, cb: (answer: string) => void) => cb("1"),
    );

    await installed!.askChoice("Pick", [
      { label: "React", description: "Library" },
      { label: "Vue", description: "Framework" },
    ]);

    expect(capture.out.data).toContain("Pick");
    expect(capture.out.data).toContain("[1] React — Library");
  });
});
