import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ToolExecutor } from "../../src/tools/executor";
import { ToolRegistry } from "../../src/tools/registry";
import type { ToolContext, ToolDefinition, ToolSecurityDecl } from "../../src/tools/types";

/** W2.2 — единая точка enforcement для `pathArgs` (INV-10). */
describe("ToolExecutor path enforcement (W2.2)", () => {
  let baseDir: string;
  let registry: ToolRegistry;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "mma-enforce-"));
    registry = new ToolRegistry();
  });
  afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

  function makeExecutor(
    scope?: ToolContext["scope"],
    config: unknown = { security: { paths: { enabled: true, denied: [], allowed: [] } } },
  ): ToolExecutor {
    const ctx = {
      config: config as any,
      baseDir,
      scope,
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        logToolCall: vi.fn(),
        logToolOutput: vi.fn(),
      } as any,
    } as ToolContext;
    return new ToolExecutor(registry, ctx, { getAllPlugins: () => [] });
  }

  function register(
    security: ToolSecurityDecl,
    handler = vi.fn(async () => ({ success: true, output: "ok" })),
  ): void {
    const def: ToolDefinition = {
      name: "t",
      description: "d",
      parameters: { type: "object", properties: {} },
      security,
      handler,
    };
    registry.register(def, "core");
  }

  it("blocks a write path outside the base directory before the handler runs", async () => {
    const handler = vi.fn(async () => ({ success: true, output: "ok" }));
    register({ caps: [{ fs: "write" }], pathArgs: ["path"] }, handler);
    const result = await makeExecutor().execute({
      id: "1",
      name: "t",
      arguments: { path: "../escape.txt" },
    });
    expect(result.success).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.output).toContain("Path not allowed");
    expect(result.output).toContain("path restriction enabled");
    expect(handler).not.toHaveBeenCalled();
  });

  it("security.paths.enabled=false lifts the jail for read and write (A10)", async () => {
    const outside = join(baseDir, "..", "outside.txt");
    const disabled = { security: { paths: { enabled: false, denied: [], allowed: [] } } };

    const readHandler = vi.fn(async () => ({ success: true, output: "ok" }));
    register({ caps: [{ fs: "read" }], pathArgs: ["path"] }, readHandler);
    const read = await makeExecutor(undefined, disabled).execute({
      id: "1",
      name: "t",
      arguments: { path: outside },
    });
    expect(read.success).toBe(true);
    expect(readHandler).toHaveBeenCalledOnce();

    const writeHandler = vi.fn(async () => ({ success: true, output: "ok" }));
    registry = new ToolRegistry();
    register({ caps: [{ fs: "write" }], pathArgs: ["path"] }, writeHandler);
    const write = await makeExecutor(undefined, disabled).execute({
      id: "2",
      name: "t",
      arguments: { path: outside },
    });
    expect(write.success).toBe(true);
    expect(writeHandler).toHaveBeenCalledOnce();
  });

  it("allows a path inside the base directory", async () => {
    const handler = vi.fn(async () => ({ success: true, output: "ok" }));
    register({ caps: [{ fs: "write" }], pathArgs: ["path"] }, handler);
    const result = await makeExecutor().execute({
      id: "1",
      name: "t",
      arguments: { path: "inside.txt" },
    });
    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("fails closed when the config has no security section (D8)", async () => {
    const handler = vi.fn(async () => ({ success: true, output: "ok" }));
    register({ caps: [{ fs: "write" }], pathArgs: ["path"] }, handler);
    const result = await makeExecutor(undefined, {}).execute({
      id: "1",
      name: "t",
      arguments: { path: "inside.txt" },
    });
    expect(result.blocked).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("blocks a protected path for writable tools (always-on)", async () => {
    const handler = vi.fn(async () => ({ success: true, output: "ok" }));
    register({ caps: [{ fs: "write" }], pathArgs: ["path"] }, handler);
    const result = await makeExecutor().execute({
      id: "1",
      name: "t",
      arguments: { path: ".env" },
    });
    expect(result.blocked).toBe(true);
    expect(result.output).toContain("[PROTECTED PATH]");
    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT apply protected-path blocking to read-only tools", async () => {
    const handler = vi.fn(async () => ({ success: true, output: "ok" }));
    register({ caps: [{ fs: "read" }], pathArgs: ["path"] }, handler);
    const result = await makeExecutor().execute({
      id: "1",
      name: "t",
      arguments: { path: ".env" },
    });
    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("applies the sub-agent scope to path args", async () => {
    register({ caps: [{ fs: "read" }], pathArgs: ["path"] });
    const executor = makeExecutor({ allowed_files: ["ok.txt"], read_only_files: [] });
    const blocked = await executor.execute({
      id: "1",
      name: "t",
      arguments: { path: "other.txt" },
    });
    expect(blocked.blocked).toBe(true);
    const allowed = await executor.execute({ id: "2", name: "t", arguments: { path: "ok.txt" } });
    expect(allowed.success).toBe(true);
  });

  it("recheck blocks a path whose parent symlink was swapped after enforcement", async () => {
    const outside = mkdtempSync(join(tmpdir(), "mma-outside-"));
    try {
      mkdirSync(join(baseDir, "inside"));
      register({ caps: [{ fs: "write" }], pathArgs: ["path"] }, async (ctx) => {
        rmSync(join(baseDir, "inside"), { recursive: true, force: true });
        try {
          symlinkSync(
            outside,
            join(baseDir, "inside"),
            process.platform === "win32" ? "junction" : "dir",
          );
        } catch {
          // Симлинки недоступны (права Windows) — проверять нечего.
          return { success: true, output: "symlink-unavailable" };
        }
        const blocked = ctx.pathGuard?.recheck(join(baseDir, "inside", "new.txt"));
        return blocked ?? { success: true, output: "not-blocked" };
      });

      const result = await makeExecutor().execute({
        id: "1",
        name: "t",
        arguments: { path: "inside/ok.txt" },
      });
      if (result.output === "symlink-unavailable") return;
      expect(result.blocked).toBe(true);
      expect(result.output).toContain("symlink");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("checks every declared path arg (from/to)", async () => {
    register({ caps: [{ fs: "write" }], pathArgs: ["from", "to"] });
    const result = await makeExecutor().execute({
      id: "1",
      name: "t",
      arguments: { from: "a.txt", to: "../outside.txt" },
    });
    expect(result.blocked).toBe(true);
  });
});
