// Релизный tarball обязан нести каталоги, которые рантайм читает С ДИСКА
// (не инлайнит бандл): browser bridge, встроенные скиллы, bundle-манифест
// сертификаций. Иначе в установленном релизе `browser` падает с
// `Cannot find module .../app/bridge-server.mjs` (наблюдалось в сессии
// ses_mv44qabg_s1przq на 0.3.2), а builtin-скиллы отсутствуют.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildStage, RUNTIME_APP_DIRS } from "../../scripts/stage-release.ts";

/** Собирает фейковый `dist/` с main.js, assets и runtime-read каталогами. */
function fakeDist(distDir: string): void {
  mkdirSync(join(distDir, "assets"), { recursive: true });
  writeFileSync(join(distDir, "main.js"), "// bundle\n");
  writeFileSync(join(distDir, "assets", "app.js"), "// asset\n");

  mkdirSync(join(distDir, "modules", "browser"), { recursive: true });
  writeFileSync(join(distDir, "modules", "browser", "bridge-server.mjs"), "// bridge\n");

  mkdirSync(join(distDir, "skills", "builtin"), { recursive: true });
  writeFileSync(join(distDir, "skills", "builtin", "git.md"), "# git skill\n");

  mkdirSync(join(distDir, "certification"), { recursive: true });
  writeFileSync(join(distDir, "certification", "certifications.json"), "{}\n");
}

describe("stage-release buildStage", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    delete process.env.RELEASE_SKIP_NODE_MODULES;
    delete process.env.RELEASE_SKIP_RUNTIME;
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("ships the runtime-read directories into app/", async () => {
    process.env.RELEASE_SKIP_NODE_MODULES = "1";
    process.env.RELEASE_SKIP_RUNTIME = "1";

    const distDir = mkdtempSync(join(tmpdir(), "mma-dist-"));
    const stage = mkdtempSync(join(tmpdir(), "mma-stage-"));
    cleanup.push(distDir, stage);
    fakeDist(distDir);

    await buildStage(stage, "0.0.0", { distDir });

    expect(existsSync(join(stage, "app", "main.js"))).toBe(true);
    expect(existsSync(join(stage, "app", "assets", "app.js"))).toBe(true);
    // The exact fail from the audited session:
    expect(existsSync(join(stage, "app", "modules", "browser", "bridge-server.mjs"))).toBe(true);
    expect(existsSync(join(stage, "app", "skills", "builtin", "git.md"))).toBe(true);
    expect(existsSync(join(stage, "app", "certification", "certifications.json"))).toBe(true);
  });

  it("lists the runtime-read dirs it must ship", () => {
    expect([...RUNTIME_APP_DIRS]).toEqual(["modules", "skills", "certification"]);
  });

  it("skips optional dirs that are absent (no throw)", async () => {
    process.env.RELEASE_SKIP_NODE_MODULES = "1";
    process.env.RELEASE_SKIP_RUNTIME = "1";

    const distDir = mkdtempSync(join(tmpdir(), "mma-dist-"));
    const stage = mkdtempSync(join(tmpdir(), "mma-stage-"));
    cleanup.push(distDir, stage);
    // No certification/ dir at all.
    mkdirSync(join(distDir, "assets"), { recursive: true });
    writeFileSync(join(distDir, "main.js"), "// bundle\n");

    await expect(buildStage(stage, "0.0.0", { distDir })).resolves.toBeUndefined();
    expect(existsSync(join(stage, "app", "certification"))).toBe(false);
  });
});
