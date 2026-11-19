import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeFileTool } from "../../src/tools/write-file";
import { t } from "../../src/i18n/index";

describe("init write-path allowlist", () => {
  let tmpDir: string;
  let ctx: any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-init-guard-"));
    ctx = {
      baseDir: tmpDir,
      config: { security: { paths: { enabled: false } } },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      sessionId: "t",
      writePathAllowlist: [join(tmpDir, "AGENTS.md")],
    };
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true });
  });

  it("rejects a write outside the allowlist", async () => {
    const result = await writeFileTool.handler(ctx, {
      path: join(tmpDir, "other.txt"),
      content: "nope",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain(t("onboarding.write_restricted"));
  });

  it("allows a write to AGENTS.md", async () => {
    const result = await writeFileTool.handler(ctx, {
      path: join(tmpDir, "AGENTS.md"),
      content: "# Notes",
    });
    expect(result.output).not.toContain(t("onboarding.write_restricted"));
  });
});
