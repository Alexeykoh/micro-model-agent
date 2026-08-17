import { describe, expect, it, afterEach } from "bun:test";
import { Repl } from "../../src/cli/repl";
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

describe("REPL persistent history", () => {
  const historyPath = join(homedir(), ".mma", "repl-history");

  afterEach(() => {
    if (existsSync(historyPath)) {
      unlinkSync(historyPath);
    }
  });

  it("should save history to ~/.mma/repl-history on stop", () => {
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

    const repl = new Repl(mockAgent, mockConfig);

    const rl = (repl as any).rl;
    rl.write("test command 1\n");
    rl.write("test command 2\n");
    repl.stop();

    expect(existsSync(historyPath)).toBe(true);
    const history = readFileSync(historyPath, "utf-8");
    expect(history).toContain("test command 1");
    expect(history).toContain("test command 2");
  });

  it("should load history from ~/.mma/repl-history on start", () => {
    const mmaDir = join(homedir(), ".mma");
    if (!existsSync(mmaDir)) mkdirSync(mmaDir, { recursive: true });

    const testHistory = "old command 1\nold command 2\nold command 3\n";
    const { writeFileSync } = require("fs");
    writeFileSync(historyPath, testHistory);

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

    const repl = new Repl(mockAgent, mockConfig);
    const history = (repl as any).history;

    expect(history).toContain("old command 1");
    expect(history).toContain("old command 2");
    expect(history).toContain("old command 3");

    repl.stop();
  });
});
