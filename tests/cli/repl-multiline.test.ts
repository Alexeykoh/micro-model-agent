import { describe, expect, it } from "bun:test";
import { Repl } from "../../src/cli/repl";
import { makeCaptureChannel } from "./capture-channel";

describe("REPL multi-line input", () => {
  const createMockRepl = () => {
    const mockAgent = {
      run: async () => ({ success: true, text: "ok", iterationCount: 1 }),
      shutdown: () => {},
    } as any;
    const mockConfig = {
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
      session: { autoSave: false, maxSessions: 50, isolateMemory: false },
    } as any;

    const { channel } = makeCaptureChannel();
    return new Repl(
      mockAgent,
      mockConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      channel,
    );
  };

  it("should detect multi-line input with backslash continuation", () => {
    const repl = createMockRepl();
    const isMultiLine = (repl as any).isMultiLineInput("function test() {\\");

    expect(isMultiLine).toBe(true);
  });

  it("should detect multi-line input with unclosed braces", () => {
    const repl = createMockRepl();
    const isMultiLine = (repl as any).isMultiLineInput("function test() {");

    expect(isMultiLine).toBe(true);
  });

  it("should not detect single-line input as multi-line", () => {
    const repl = createMockRepl();
    const isMultiLine = (repl as any).isMultiLineInput("const x = 1");

    expect(isMultiLine).toBe(false);
  });

  it("should not detect closed braces as multi-line", () => {
    const repl = createMockRepl();
    const isMultiLine = (repl as any).isMultiLineInput("function test() {}");

    expect(isMultiLine).toBe(false);
  });
});
