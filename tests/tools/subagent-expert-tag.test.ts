/**
 * `expert_tag` субагента: список конфигурируемых экспертов виден модели в схеме,
 * а отказ на неизвестный тег оставляет след в audit (`ses_mvoac9q9`, дефект D5).
 *
 * В той сессии модель дважды отправила `expert_tag: "code-review"` (имя скилла),
 * получила `[SECURITY BLOCKED]` без записи в audit и повторила тот же вызов
 * после `load_skill`.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subagentTool, subagentToolWithExperts } from "../../src/tools/subagent";
import { registerAllTools } from "../../src/tools";
import { ToolRegistry } from "../../src/tools/registry";
import { clearAuditSessionDir, setAuditSessionDir } from "../../src/modules/security/audit-log";
import type { AuditLogEntry } from "../../src/modules/security/audit-log";

const EXPERTS = { code: {}, research: {} };

function makeCtx(baseDir: string) {
  return {
    config: { contextWindow: 32768, experts: EXPERTS },
    baseDir,
    sessionId: "ses_expert_tag_test",
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

describe("subagent expert_tag", () => {
  it("lists configured experts in the registered tool description", () => {
    const registry = new ToolRegistry();
    registerAllTools(registry, undefined, { expertTags: ["code", "research"] });
    const registered = registry.get("subagent");
    expect(registered).toBeDefined();
    const description = registered!.description;
    expect(description).toContain("code, research");
    const expert = (registered!.parameters as {
      properties: Record<string, { description?: string }>;
    }).properties.expert_tag;
    expect(expert.description).toContain("code, research");
    expect(expert.description).toContain("load_skill");
  });

  it("keeps the plain tool when no experts are configured", () => {
    expect(subagentToolWithExperts([])).toBe(subagentTool);
  });

  it("names the configured experts and the likely confusion on an unknown tag", async () => {
    const result = await subagentTool.handler(makeCtx(tmpdir()), {
      task: "review the code",
      expert_tag: "code-review",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("[SECURITY BLOCKED]");
    expect(result.output).toContain("code, research");
    // Подсказка: это не скилл, скиллы грузятся load_skill.
    expect(result.output).toContain("load_skill");
    expect(result.output).toContain("tool_tags");
  });

  it("writes the refusal to audit.jsonl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-audit-expert-"));
    setAuditSessionDir(dir, "ses_expert_tag_test");
    try {
      await subagentTool.handler(makeCtx(tmpdir()), {
        task: "review the code",
        expert_tag: "code-review",
      });
      const file = join(dir, "audit.jsonl");
      expect(existsSync(file), "audit.jsonl не создан").toBe(true);
      const entries = readFileSync(file, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AuditLogEntry);
      const block = entries.find((e) => e.action === "security_block");
      expect(block, "нет записи security_block").toBeDefined();
      expect(block!.reason).toContain("Unknown expert_tag");
      expect(block!.details).toContain("code-review");
      expect(block!.success).toBe(false);
    } finally {
      clearAuditSessionDir("ses_expert_tag_test");
    }
  });
});
