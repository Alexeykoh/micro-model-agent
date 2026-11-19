import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { bashTool } from "../../src/tools/bash";

/**
 * `bash` не должен выходить за пределы рабочего каталога и скоупа
 * субагента (аудит §4.1, план `2026-10-12-harness-module-audit-fixes`, W3/Task 3.1).
 */

const root = mkdtempSync(join(tmpdir(), "mma-bash-scope-"));
const project = join(root, "proj");
mkdirSync(project, { recursive: true });
mkdirSync(join(project, "src"), { recursive: true });

function makeCtx(baseDir: string, extra: Record<string, unknown> = {}) {
  return {
    baseDir,
    config: {},
    logger: { info: () => {}, error: () => {} },
    ...extra,
  } as unknown as Parameters<typeof bashTool.handler>[0];
}

describe("bash: workdir jail", () => {
  it("blocks a workdir outside the base directory", async () => {
    const ctx = makeCtx(project, {
      config: { security: { paths: { enabled: true, denied: [], allowed: [] } } },
    });
    const res = await bashTool.handler(ctx, { command: "dir", workdir: dirname(project) });
    expect(res.success).toBe(false);
    expect(res.output).toContain("[SECURITY BLOCKED]");
    expect(res.output).toContain("path restriction enabled");
  });

  it("allows a workdir outside base when security.paths.enabled=false (A10)", async () => {
    const ctx = makeCtx(project, {
      config: { security: { paths: { enabled: false, denied: [], allowed: [] } } },
    });
    const res = await bashTool.handler(ctx, { command: "echo hello", workdir: dirname(project) });
    expect(res.success).toBe(true);
    expect(res.output).toContain("hello");
  });

  it("still requires writable scope for bash when the jail is lifted", async () => {
    const ctx = makeCtx(project, {
      config: { security: { paths: { enabled: false, denied: [], allowed: [] } } },
      scope: { allowed_files: [], read_only_files: ["src"] },
    });
    const res = await bashTool.handler(ctx, { command: "echo hello", workdir: dirname(project) });
    expect(res.success).toBe(false);
    expect(res.output).toContain("[SECURITY BLOCKED]");
  });

  it("allows the project root as workdir for a scoped sub-agent", async () => {
    // Скоуп — список файлов, а cwd bash работает каталогом: корень проекта
    // не обязан попадать в `allowed_files` (спека subagent-reliability §A).
    const ctx = makeCtx(project, {
      scope: { allowed_files: ["src"], read_only_files: [] },
    });
    const res = await bashTool.handler(ctx, { command: "echo hello", workdir: project });
    expect(res.success).toBe(true);
    expect(res.output).toContain("hello");
  });

  it("still blocks a workdir outside the base directory for a scoped sub-agent", async () => {
    const ctx = makeCtx(project, {
      scope: { allowed_files: ["src"], read_only_files: [] },
    });
    const res = await bashTool.handler(ctx, { command: "dir", workdir: dirname(project) });
    expect(res.success).toBe(false);
    expect(res.output).toContain("[SECURITY BLOCKED]");
  });

  it("blocks bash for a read-only sub-agent", async () => {
    // `read_only_files` не даёт права записи, а bash — тул с записью.
    const ctx = makeCtx(project, {
      scope: { allowed_files: [], read_only_files: ["src"] },
    });
    const res = await bashTool.handler(ctx, { command: "echo hello", workdir: project });
    expect(res.success).toBe(false);
    expect(res.output).toContain("[SECURITY BLOCKED]");
  });

  it("allows a workdir inside the base directory", async () => {
    const ctx = makeCtx(project);
    const res = await bashTool.handler(ctx, { command: "echo hello", workdir: project });
    expect(res.success).toBe(true);
    expect(res.output).toContain("hello");
  });

  it("allows a workdir inside the sub-agent scope", async () => {
    const ctx = makeCtx(project, {
      scope: { allowed_files: ["src"], read_only_files: [] },
    });
    const res = await bashTool.handler(ctx, {
      command: "echo hello",
      workdir: join(project, "src"),
    });
    expect(res.success).toBe(true);
    expect(res.output).toContain("hello");
  });

  it("resolves a relative workdir against the base directory", async () => {
    const ctx = makeCtx(project);
    const res = await bashTool.handler(ctx, { command: "echo hello", workdir: "src" });
    expect(res.success).toBe(true);
    expect(res.output).toContain("hello");
  });
});
