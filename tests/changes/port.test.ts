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

  it("does not evict for tools without snapshots or when capture is disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "mma-port-narrow-"));
    try {
      let dirCalls = 0;
      const config = structuredClone(DEFAULTS) as AppConfig;
      const sessionManager = {
        getSessionDirectory: (id: string) => {
          dirCalls++;
          return join(root, "sessions", id);
        },
      };
      const port = createFileChangesPort({ sessionManager, getConfig: () => config });
      port.beginTurn("s1");
      const ctx = { sessionId: "s1", baseDir: root } as ToolContext;
      const readTool = { name: "read_file" } as ToolDefinition;
      const writeTool = { name: "write_file" } as ToolDefinition;

      dirCalls = 0;
      port.captureBefore(ctx, readTool, { id: "c_read", name: "read_file", arguments: {} });
      port.captureAfter("c_read", true);
      expect(dirCalls).toBe(0); // evict would resolve the session directory

      config.changes!.enabled = false;
      dirCalls = 0;
      port.captureBefore(ctx, writeTool, { id: "c_off", name: "write_file", arguments: {} });
      port.captureAfter("c_off", true);
      expect(dirCalls).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
