/** FRW4AG-followup: шесть дефектов системного промпта из §9.specs. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../src/config/defaults";
import {
  buildSystemInfo,
  NARRATION_DIRECTIVE_AFTER_SILENT_BATCHES,
  RETRY_GUIDANCE_ATTEMPTS,
} from "../src/core/system-prompt-render";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = (path: string): string => readFileSync(join(ROOT, path), "utf8");

function prompt(security = false): string {
  const config = structuredClone(DEFAULTS);
  if (security) {
    config.security = {
      ...config.security,
      enabled: true,
      bash: {
        ...config.security.bash,
        enabled: true,
        blacklist: ["curl", "wget", "docker", "npm", "pnpm", "yarn", "bun", "git", "python", "node", "powershell", "cmd", "ssh", "scp", "rsync"],
        whitelist: [],
        blockDangerousFlags: true,
      },
    };
  }
  return buildSystemInfo(config, "/tmp", "win32 shell=cmd", undefined, "full");
}

describe("system prompt guidance (FRW4AG-followup)", () => {
  it("has one list_dir rule instead of three conflicting ones", () => {
    const rules = prompt().split("\n").filter((line) => line.includes("list_dir"));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain("named path");
  });

  it("does not duplicate bash operators in the prose security block", () => {
    const text = prompt(true);
    expect(text).toContain("SECURITY RESTRICTIONS");
    expect(text).not.toContain("Forbidden bash commands:");
    expect(text).not.toContain("| > >> ; &&");
  });

  it("states retry and narration limits once from constants", () => {
    const text = prompt();
    expect(RETRY_GUIDANCE_ATTEMPTS).toBe(2);
    expect(NARRATION_DIRECTIVE_AFTER_SILENT_BATCHES).toBe(3);
    expect(text).toContain(`${RETRY_GUIDANCE_ATTEMPTS} different failed approaches`);
    expect(text).toContain(`silent batches <=${NARRATION_DIRECTIVE_AFTER_SILENT_BATCHES}`);
    expect(text).not.toContain("3rd time");
    expect(text).not.toContain("2+ approaches");
  });

  it("plan reminder reads live state and does not advertise a removed plan block", () => {
    const text = source("src/core/bootstrap/modules-prompt.ts");
    expect(text).not.toContain("plan show");
    expect(text).toContain("system-summary");
  });

  it("browser module points to the tool description instead of a second canon", () => {
    const text = source("src/modules/browser/module.ts");
    expect(text).not.toContain("Workflow: open");
    expect(text).toContain("browser tool's own workflow");
  });

  it("keeps the LSP header in English despite localized user settings", () => {
    const text = source("src/modules/lsp/startup-check.ts");
    expect(text).not.toContain('t("lsp.startup_header")');
    expect(text).toContain("LSP startup check");
  });
});
