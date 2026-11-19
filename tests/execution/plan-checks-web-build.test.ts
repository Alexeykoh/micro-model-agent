import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { checkDoneEvidence, parseCheck } from "../../src/modules/execution/plan-checks";
import { createTestModule, cleanupTestModule } from "../plan-test-utils";

/**
 * `web-build:` через публичный исполнитель check-контрактов (checkDoneEvidence)
 * и через plan_step done. Гейт должен блокировать «сборка прошла, артефакт
 * пустой/без CSS» и пропускать настоящий Tailwind-билд.
 */

const TAILWIND_CSS = ".grid{display:grid}.flex{display:flex}";
const SPA_HTML = '<html><body><div id="app"></div><script src="/app.js"></script></body></html>';

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function writeBuild(root: string): void {
  write(root, "dist/assets/app.css", TAILWIND_CSS);
  write(root, "dist/index.html", SPA_HTML);
}

describe("checkDoneEvidence: web-build", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "mma-webbuild-evidence-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  const target = { description: "Build the site", check: "web-build:dist" };

  it("passes with a note when the artifact is valid", async () => {
    writeBuild(baseDir);
    const res = await checkDoneEvidence(parseCheck("web-build:dist")!, target, 1, { baseDir });
    expect(res).not.toBeNull();
    expect(res!.blocked).toBeNull();
    expect(res!.note).toContain("dist");
  });

  it("blocks with the concrete reason when the build is missing", async () => {
    const res = await checkDoneEvidence(parseCheck("web-build:dist")!, target, 2, { baseDir });
    expect(res).not.toBeNull();
    expect(res!.blocked?.success).toBe(false);
    expect(res!.blocked?.output).toContain("dist");
    expect(res!.blocked?.output).toContain("no built CSS found");
  });

  it("blocks when no baseDir is supplied", async () => {
    const res = await checkDoneEvidence(parseCheck("web-build:dist")!, target, 3);
    expect(res!.blocked?.success).toBe(false);
    expect(res!.blocked?.output).toContain("no base directory");
  });
});

describe("plan_step done: web-build gate", () => {
  let tmpDir: string;
  let execModule: ReturnType<typeof createTestModule>["execModule"];

  beforeEach(() => {
    ({ tmpDir, execModule } = createTestModule("mma-webbuild-plan-"));
  });

  afterEach(() => {
    cleanupTestModule(tmpDir);
  });

  function planTool() {
    return execModule.getToolDefinitions().find((t) => t.name === "plan")!;
  }

  function stepTool() {
    return execModule.getToolDefinitions().find((t) => t.name === "plan_step")!;
  }

  it("blocks done until dist has CSS utilities and a non-empty index.html", async () => {
    const created = await planTool().handler(
      {},
      {
        action: "create",
        title: "Build web app",
        steps: ["Build the marketing site"],
        checks: ["web-build:dist"],
      },
    );
    expect(created.success).toBe(true);

    const blocked = await stepTool().handler({}, { step: 1, status: "done" });
    expect(blocked.success).toBe(false);
    expect(blocked.output).toContain("dist");

    writeBuild(tmpDir);
    const ok = await stepTool().handler({}, { step: 1, status: "done" });
    expect(ok.success).toBe(true);
    expect(ok.output).toContain("dist");
  });
});
