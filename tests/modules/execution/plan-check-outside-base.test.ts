import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { StepVerifier } from "../../../src/modules/execution/verifier";
import { expandPath } from "../../../src/modules/execution/check-path";
import { ExecutionModule } from "../../../src/modules/execution/module";

/**
 * A9/A10: проверки плана резолвят путь через тот же `path-validator`, что и
 * тулы, и раскрывают `~`/`%VAR%`. При `security.paths.enabled=false` путь вне
 * baseDir проверяется нормально, при включённом — отказ с причиной, а не
 * «файл не существует».
 */

const ENABLED = { enabled: true, denied: [], allowed: [] };
const DISABLED = { enabled: false, denied: [], allowed: [] };

describe("expandPath", () => {
  const env = { USERPROFILE: "C:\\Users\\alex", HOME: "/home/alex" };

  it("expands ~ to home", () => {
    expect(expandPath("~/.mma/config.json", { home: "/home/alex", env })).toBe(
      "/home/alex/.mma/config.json",
    );
  });

  it("expands %VAR% and $VAR / ${VAR} without a shell", () => {
    expect(expandPath("%USERPROFILE%/.mma/config.json", { env })).toBe(
      "C:\\Users\\alex/.mma/config.json",
    );
    expect(expandPath("$HOME/.mma/config.json", { env })).toBe("/home/alex/.mma/config.json");
    expect(expandPath("${HOME}/.mma/config.json", { env })).toBe("/home/alex/.mma/config.json");
  });

  it("leaves unknown variables untouched", () => {
    expect(expandPath("%MMA_NO_SUCH_VAR%/x.json", { env })).toBe("%MMA_NO_SUCH_VAR%/x.json");
  });
});

describe("StepVerifier path checks (A9/A10)", () => {
  let baseDir: string;
  let outsideDir: string;
  let outsideFile: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "mma-check-base-"));
    outsideDir = mkdtempSync(join(tmpdir(), "mma-check-out-"));
    outsideFile = join(outsideDir, "config.json");
    writeFileSync(outsideFile, "{}");
    writeFileSync(join(baseDir, "inside.json"), "{}");
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("rejects an outside path with an explicit reason when the restriction is enabled", async () => {
    const verifier = new StepVerifier(baseDir, undefined, ENABLED);
    const res = await verifier.checkFileExists(outsideFile);
    expect(res.passed).toBe(false);
    expect(res.message).toContain("outside the working directory");
    expect(res.message).not.toContain("File not found");
  });

  it("checks an outside path normally when enabled=false", async () => {
    const verifier = new StepVerifier(baseDir, undefined, DISABLED);
    const res = await verifier.checkFileExists(outsideFile);
    expect(res.passed).toBe(true);
  });

  it("keeps legacy behaviour for constructors without a config", async () => {
    const verifier = new StepVerifier(baseDir);
    const res = await verifier.checkFileExists(outsideFile);
    expect(res.passed).toBe(true);
  });

  it("expands %VAR% before validating and checking existence", async () => {
    process.env.MMA_TEST_CHECK_PROFILE = outsideDir;
    try {
      const verifier = new StepVerifier(baseDir, undefined, DISABLED);
      const res = await verifier.checkFileExists("%MMA_TEST_CHECK_PROFILE%/config.json");
      expect(res.passed).toBe(true);
    } finally {
      delete process.env.MMA_TEST_CHECK_PROFILE;
    }
  });

  it("applies the sub-agent scope even when the jail is lifted", async () => {
    const verifier = new StepVerifier(baseDir, undefined, DISABLED);
    const res = await verifier.checkFileExists("inside.json", {
      allowed_files: [],
      read_only_files: [],
    });
    expect(res.passed).toBe(false);
    expect(res.message).toContain("scope");
  });
});

describe("plan_step file-exists outside baseDir (A9)", () => {
  let baseDir: string;
  let outsideDir: string;
  let outsideFile: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "mma-plan-check-base-"));
    outsideDir = mkdtempSync(join(tmpdir(), "mma-plan-check-out-"));
    outsideFile = join(outsideDir, "config.json");
    writeFileSync(outsideFile, "{}");
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  async function createStepPlan(module: ExecutionModule): Promise<void> {
    const plan = module.getToolDefinitions().find((t) => t.name === "plan")!;
    const res = await plan.handler(
      {},
      {
        action: "create",
        title: "External config",
        steps: ["Update external tool config"],
        checks: [`file-exists:${outsideFile}`],
      },
    );
    expect(res.success).toBe(true);
  }

  function stepTool(module: ExecutionModule) {
    return module.getToolDefinitions().find((t) => t.name === "plan_step")!;
  }

  it("passes when security.paths.enabled=false", async () => {
    const module = new ExecutionModule(baseDir, 8, 5, undefined, undefined, DISABLED);
    await createStepPlan(module);
    const res = await stepTool(module).handler({}, { step: 1, status: "done" });
    expect(res.success).toBe(true);
  });

  it("fails with the path reason (not 'file not found') when enabled", async () => {
    const module = new ExecutionModule(baseDir, 8, 5, undefined, undefined, ENABLED);
    await createStepPlan(module);
    const res = await stepTool(module).handler({}, { step: 1, status: "done" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("outside the working directory");
    expect(res.output).not.toContain("File not found");
  });
});
