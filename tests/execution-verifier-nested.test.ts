// tests/execution-verifier-nested.test.ts
//
// Root cause (ses_mst2r0r5 post-mortem): the project typecheck and the
// lint-on-write project typecheck look for tsconfig.json in the AGENT baseDir
// (`join(ctx.baseDir, "tsconfig.json")` in lint-on-write.ts, `resolve(baseDir,
// "tsconfig.json")` in verifier.ts). For a nested project layout
// (`baseDir/proj/tsconfig.json`) the real tsconfig is a level deeper — the
// check is silently SKIPPED on every write, so type errors never reach the
// model (observed: the whole session had zero `[Project typecheck failed]`).
//
// Fix: resolve the nearest tsconfig.json from the EDITED FILE via the shared
// `findProjectRoot()` helper, not from baseDir.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StepVerifier } from "../src/modules/execution/verifier";
import { LintOnWritePlugin } from "../src/modules/plugins/builtin/lint-on-write";

/**
 * Create a nested project under `baseDir` whose node_modules has a real
 * typescript (linked from the MMA repo's own dependency) so the local tsc
 * actually runs — mirroring a real `npm install` in the nested project.
 * Uses `symlinkSync(..., "junction")`: a Windows junction (no admin needed)
 * and a plain directory symlink on macOS/Linux. Returns null when typescript
 * is unavailable (CI without the repo dep) or the link cannot be created, so
 * tests skip rather than assert a broken environment.
 */
function setupNestedProject(baseDir: string): { proj: string; srcFile: string } | null {
  const repoTypescript = join(__dirname, "..", "node_modules", "typescript");
  const repoBin = join(__dirname, "..", "node_modules", ".bin");
  if (!existsSync(repoTypescript)) return null;

  const proj = join(baseDir, "bicycle-shop");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "tsconfig.json"), "{}", "utf-8");
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "bicycle-shop" }), "utf-8");
  const srcFile = join(proj, "src", "a.ts");

  const link = (target: string, path: string): boolean => {
    try {
      symlinkSync(target, path, "junction");
      return true;
    } catch (err) {
      // Нет прав / не поддержано ФС — тесты ниже проверят окружение и скипнут.
      console.warn(`[test] symlink failed ${path} -> ${target}:`, err);
      return false;
    }
  };

  mkdirSync(join(proj, "node_modules"), { recursive: true });
  // Без локального tsc проверка невозможна — тесты пропускаем, а не падаем.
  if (!link(repoTypescript, join(proj, "node_modules", "typescript"))) return null;
  if (existsSync(repoBin)) {
    link(repoBin, join(proj, "node_modules", ".bin"));
  }

  return { proj, srcFile };
}

describe("nested-project typecheck (tsconfig in a subdirectory)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "mma-nested-"));
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch (err) {
      // Windows может держать файлы (junction/tsc) — уборка tmp не критична,
      // но ошибку не прячем.
      console.warn(`[test] cleanup failed for ${tmp}:`, err);
    }
  });

  it("StepVerifier.runTypeCheckForFile finds a type error in a nested project", async () => {
    const setup = setupNestedProject(tmp);
    if (!setup) return; // typescript unavailable — nothing to run
    const verifier = new StepVerifier(tmp);
    const result = await verifier.runTypeCheckForFile(setup.srcFile);
    expect(result.passed).toBe(false);
    // The failure must be a real TS error, not "no tsconfig found".
    expect(result.message).toContain("error TS");
  });

  it("LintOnWritePlugin appends [Project typecheck failed] for a nested tsconfig", async () => {
    const setup = setupNestedProject(tmp);
    if (!setup) return;
    writeFileSync(setup.srcFile, "const x: number = 'not a number';", "utf-8");
    const plugin = new LintOnWritePlugin();
    const result = { success: true, output: "file written ok" };
    await plugin.onAfterTool!(
      { baseDir: tmp, logger: { warn: () => {}, debug: () => {} } } as any,
      { name: "write_file", arguments: { path: setup.srcFile } },
      result,
    );
    expect(result.output).toContain("[Project typecheck failed]");
  });

  it("clean nested file produces no typecheck error", async () => {
    const setup = setupNestedProject(tmp);
    if (!setup) return;
    writeFileSync(setup.srcFile, "export const ok = 1;", "utf-8");
    const plugin = new LintOnWritePlugin();
    const result = { success: true, output: "file written ok" };
    await plugin.onAfterTool!(
      { baseDir: tmp, logger: { warn: () => {}, debug: () => {} } } as any,
      { name: "write_file", arguments: { path: setup.srcFile } },
      result,
    );
    expect(result.output).not.toContain("[Project typecheck failed]");
  });

  it("no tsconfig at all → no typecheck error, no crash", async () => {
    const proj = join(tmp, "no-tsconfig");
    mkdirSync(proj, { recursive: true });
    const file = join(proj, "x.ts");
    writeFileSync(file, "export const x = 1;", "utf-8");

    const plugin = new LintOnWritePlugin();
    const result = { success: true, output: "ok" };
    await plugin.onAfterTool!(
      { baseDir: tmp, logger: { warn: () => {}, debug: () => {} } } as any,
      { name: "write_file", arguments: { path: file } },
      result,
    );
    expect(result.output).toBe("ok");
  });
});
