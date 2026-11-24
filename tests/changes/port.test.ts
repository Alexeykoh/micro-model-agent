import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import { createFileChangesPort } from "../../src/modules/changes";
import { ToolExecutor } from "../../src/tools/executor";
import { ToolRegistry } from "../../src/tools/registry";
import type { ToolContext, ToolDefinition } from "../../src/tools/types";

describe("FileChangesPort", () => {
  it("records a successful write executed through ToolExecutor and restores it", async () => {
    const root = mkdtempSync(join(tmpdir(), "mma-port-"));
    try {
      const config = structuredClone(DEFAULTS) as AppConfig;
      const sessionManager = { getSessionDirectory: (id: string) => join(root, "sessions", id) };
      mkdirSync(join(root, "sessions", "s1"), { recursive: true });
      const port = createFileChangesPort({ sessionManager, getConfig: () => config });
      port.beginTurn("s1");
      const file = join(root, "a.txt");
      writeFileSync(file, "before");
      const tool: ToolDefinition = {
        name: "write_file", description: "", parameters: {}, security: { caps: [{ fs: "write" }] },
        handler: async () => { writeFileSync(file, "after"); return { success: true, output: "ok" }; },
      };
      const registry = new ToolRegistry();
      registry.register(tool, "test");
      const ctx = {
        config, baseDir: root, logger: { debug() {}, info() {}, warn() {}, error() {}, logToolCall() {}, logToolOutput() {} } as never,
        sessionId: "s1", exitOnComplete: true, contextManager: {} as never, activeToolTags: [],
        fileChanges: port,
      } as unknown as ToolContext;
      const result = await new ToolExecutor(registry, ctx, { getAllPlugins: () => [] } as never)
        .execute({ id: "call1", name: "write_file", arguments: { path: "a.txt" } });
      expect(result.success).toBe(true);
      const entries = port.list({ sessionId: "s1", baseDir: root, path: "a.txt" });
      expect(entries.length).toBe(1);
      expect(port.undo({ sessionId: "s1", baseDir: root, path: "a.txt" }).ok).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("before");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
