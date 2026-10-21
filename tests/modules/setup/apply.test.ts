import { describe, it, expect } from "vitest";
import {
  applyAnswersToConfigWithWarnings,
  applySecurityDetail,
} from "../../../src/modules/setup/apply";
import { securityDetailFromConfig } from "../../../src/modules/setup/answers";
import { DEFAULTS } from "../../../src/config/defaults";
import type { AppConfig } from "../../../src/config/types";
import type { SetupAnswers } from "../../../src/modules/setup/answers";

/**
 * Setup-мастер: выборы визарда применяются честно (аудит §7.11/§7.12, план
 * `2026-10-12-harness-module-audit-fixes`, W7/Task 7.7).
 */

function answers(overrides: Partial<SetupAnswers> = {}): SetupAnswers {
  return {
    provider: "openai-compat",
    apiBase: "https://api.example.com/v1",
    apiKey: "sk-x",
    model: "qwen/qwen3.5-9b",
    contextWindow: 65536,
    maxToolIterations: 25,
    locale: "en",
    securityFlagsBlock: true,
    securityBashBlock: false,
    securityPathsRestrict: false,
    ...overrides,
  } as SetupAnswers;
}

function config(): AppConfig {
  return structuredClone(DEFAULTS) as AppConfig;
}

describe("setup: применение ответов визарда", () => {
  it("a wizard-provided context window sticks and turns auto off", () => {
    const cfg = config();
    cfg.contextAuto = true;
    applyAnswersToConfigWithWarnings(cfg, answers({ contextWindow: 65536 }));
    expect(cfg.contextWindow).toBe(65536);
    expect(cfg.contextAuto).toBe(false);
  });

  it("refuses to overwrite a different provider entry when active is stale", () => {
    const cfg = config();
    cfg.provider.entries = [
      { type: "openai-compat", label: "work", baseUrl: "https://work/v1" },
    ];
    cfg.provider.active = "deleted-one";
    const r = applyAnswersToConfigWithWarnings(
      cfg,
      answers({ apiBase: "http://x", apiKey: "sk-y" }),
    );
    expect(r.warnings).toContain(
      "provider.active does not match any entry; provider settings not applied",
    );
    // Чужая запись не тронута.
    expect(cfg.provider.entries[0]?.baseUrl).toBe("https://work/v1");
  });

  it("honours a zero numeric security override", () => {
    const cfg = config();
    applySecurityDetail(cfg.security!, { advanced: { maxRecursionDepth: 0 } } as never);
    expect(cfg.security?.maxRecursionDepth).toBe(0);
  });

  it("security detail projection survives missing fields", () => {
    const detail = securityDetailFromConfig({} as never);
    expect(detail.bash.blacklist).toEqual([]);
    expect(detail.network.requestTimeout).toBe(0);
    expect(detail.advanced.auditNotifierMinSeverity).toBe("medium");
  });
});
