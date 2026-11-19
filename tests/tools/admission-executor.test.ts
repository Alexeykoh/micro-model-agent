import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../../src/tools/executor";
import { ToolRegistry } from "../../src/tools/registry";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mma-exec-admit-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function makeExecutor(output: string, config: unknown = { contextBudget: { admitMaxTokens: 100 } }) {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: "big_tool",
      description: "returns a big output",
      parameters: { type: "object", properties: {} },
      security: { caps: [] },
      handler: async () => ({ success: true, output }),
    },
    "test",
  );
  const ctx = {
    config,
    baseDir: dir,
    sessionId: "s1",
    logger: {
      debug: () => {}, info: () => {}, warn: () => {},
      logToolCall: () => {}, logToolOutput: () => {},
    },
  };
  const pluginManager = { getAllPlugins: () => [] };
  return new ToolExecutor(registry, ctx as any, pluginManager as any);
}

describe("ToolExecutor admission", () => {
  it("spills oversized tool output and returns a descriptor", async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `row ${i}`).join("\n");
    const executor = makeExecutor(big);
    const res = await executor.execute({ id: "1", name: "big_tool", arguments: {} });
    expect(res.artifactPath).toBeTruthy();
    expect(res.output).not.toContain("row 3999");
    expect(readFileSync(res.artifactPath as string, "utf8")).toBe(big);
  });

  it("leaves small tool output unchanged", async () => {
    const executor = makeExecutor("tiny");
    const res = await executor.execute({ id: "2", name: "big_tool", arguments: {} });
    expect(res.output).toBe("tiny");
    expect(res.artifactPath).toBeUndefined();
  });

  it("falls back to the default threshold when contextBudget is absent", async () => {
    const big = Array.from({ length: 6000 }, (_, i) => `row ${i}`).join("\n");
    const executor = makeExecutor(big, {});
    const res = await executor.execute({ id: "3", name: "big_tool", arguments: {} });
    expect(res.artifactPath).toBeTruthy();
    expect(res.output).not.toContain("row 5999");
  });
});
