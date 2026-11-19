import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import {
  checkWebBuild,
  WEB_BUILD_CSS_CAP_BYTES,
} from "../../../src/modules/execution/web-build-check";
import { classifyCheck, parseCheck } from "../../../src/modules/execution/plan-checks";

/**
 * Post-build гейт (TODO §1.12, F-30/F-34): `web-build:` проверяет сам
 * артефакт, а не exit-код сборки. CSS обязан содержать Tailwind-утилиты,
 * index.html — быть непустым (текст или корневой узел SPA).
 */

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const TAILWIND_CSS = `
  .grid { display: grid; }
  .flex{ display: flex; }
  :root{ --tw-ring-offset-width: 0px; }
`;
const PLAIN_CSS = `.hero-banner { color: #123; }\n`;
const SPA_HTML =
  '<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css"></head>' +
  '<body><div id="root"></div><script src="/assets/app.js"></script></body></html>';

describe("checkWebBuild", () => {
  let baseDir: string;
  let outsideDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "mma-web-build-"));
    outsideDir = mkdtempSync(join(tmpdir(), "mma-web-build-out-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("accepts a Tailwind build with a non-empty SPA shell", () => {
    write(baseDir, "dist/assets/app.css", TAILWIND_CSS);
    write(baseDir, "dist/index.html", SPA_HTML);

    const res = checkWebBuild(baseDir, "dist");
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(res.cssFiles).toContain("dist/assets/app.css");
  });

  it("accepts visible text instead of an SPA root marker", () => {
    write(baseDir, "build/styles.css", TAILWIND_CSS);
    write(baseDir, "build/index.html", "<html><body><h1>Welcome to the catalog</h1></body></html>");

    expect(checkWebBuild(baseDir, "build").ok).toBe(true);
  });

  it("accepts `--tw-` alone and whitespace before `{`", () => {
    write(baseDir, "out/a.css", ":root{--tw-ring-offset-width:2px}");
    write(baseDir, "out/index.html", SPA_HTML);
    expect(checkWebBuild(baseDir, "out").ok).toBe(true);
  });

  it("finds the build dir under a project root", () => {
    write(baseDir, "dist/assets/app.css", TAILWIND_CSS);
    write(baseDir, "dist/index.html", SPA_HTML);
    expect(checkWebBuild(baseDir, ".").ok).toBe(true);
  });

  it("caps CSS reading per file", () => {
    // Utility markers live past the cap and must not be counted.
    write(baseDir, "dist/a.css", `${"x".repeat(WEB_BUILD_CSS_CAP_BYTES)}.grid{.flex{`);
    write(baseDir, "dist/index.html", SPA_HTML);
    const res = checkWebBuild(baseDir, "dist");
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("no utility classes");
  });

  it("fails when CSS exists but Tailwind was not generated", () => {
    write(baseDir, "dist/assets/app.css", PLAIN_CSS);
    write(baseDir, "dist/index.html", SPA_HTML);

    const res = checkWebBuild(baseDir, "dist");
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("no utility classes");
  });

  it("fails when no CSS exists at all", () => {
    write(baseDir, "dist/index.html", SPA_HTML);
    const res = checkWebBuild(baseDir, "dist");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no built CSS found");
    expect(res.cssFiles).toEqual([]);
  });

  it("fails when index.html is missing", () => {
    write(baseDir, "dist/assets/app.css", TAILWIND_CSS);
    const res = checkWebBuild(baseDir, "dist");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no index.html in build output");
  });

  it("fails when the page body is empty and has no root node", () => {
    write(baseDir, "dist/assets/app.css", TAILWIND_CSS);
    write(
      baseDir,
      "dist/index.html",
      "<html><head><style>body{color:red}</style></head><body>" +
        "<script>const longEnoughTextThatIsNotVisible = true;</script>" +
        "<!-- a comment long enough to fool a naive text check --></body></html>",
    );

    const res = checkWebBuild(baseDir, "dist");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("page is empty");
  });

  it("rejects a directory outside baseDir", () => {
    write(outsideDir, "dist/assets/app.css", TAILWIND_CSS);
    write(outsideDir, "dist/index.html", SPA_HTML);

    for (const dir of [outsideDir, join("..", "escape")]) {
      const res = checkWebBuild(baseDir, dir);
      expect(res.ok, dir).toBe(false);
      expect(res.reason, dir).toBeTruthy();
      expect(res.cssFiles, dir).toEqual([]);
    }
  });
});

describe("web-build: check kind", () => {
  it("parses as its own behavioral artifact check", () => {
    const parsed = parseCheck("web-build:dist");
    expect(parsed).toEqual({ kind: "web-build", target: "dist" });
    expect(classifyCheck(parsed!)).toBe("behavioral");
  });
});
