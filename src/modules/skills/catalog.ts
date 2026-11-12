// Catalog prompt block: top-N skills by usage, falling back to source order.
import type { PromptBlock } from "../../core/types";
import type { SkillMeta } from "./loader";
import type { SkillUsage } from "./usage";
import { estimateTokens } from "../../llm/token-counter";

/** How many skill names the prompt catalog shows (9B context budget). */
export const CATALOG_LIMIT = 10;

/**
 * Catalog size on large windows (L2): большая модель выбирает из большего
 * списка без потерь, малой хватает топ-10. Дефолт параметра — small-канон.
 */
export const LARGE_CATALOG_LIMIT = 25;

/**
 * Orders skills for the catalog: skills with a usage count first (count desc,
 * then name), unused skills afterwards in the order they were scanned.
 */
export function rankSkills(skills: SkillMeta[], usage?: SkillUsage): SkillMeta[] {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const ranked: SkillMeta[] = [];
  const seen = new Set<string>();

  for (const name of usage?.topNames(skills.length) ?? []) {
    const skill = byName.get(name);
    if (!skill || seen.has(name)) continue;
    ranked.push(skill);
    seen.add(name);
  }
  for (const skill of skills) {
    if (!seen.has(skill.name)) ranked.push(skill);
  }
  return ranked;
}

/** Compact `[Available Skills]` block; null when there are no skills. */
export function buildCatalogBlock(
  skills: SkillMeta[],
  usage?: SkillUsage,
  limit: number = CATALOG_LIMIT,
): PromptBlock | null {
  if (skills.length === 0) return null;
  const shown = rankSkills(skills, usage).slice(0, Math.max(1, limit));
  const lines = [
    "[Available Skills]",
    'Skills extend your knowledge. Load one with "load_skill" when it matches the task;',
    'if the skill you need is not listed, call "load_skill" with a query.',
  ];
  for (const skill of shown) lines.push(`- ${skill.name}`);
  const hidden = skills.length - shown.length;
  if (hidden > 0) {
    lines.push(`…and ${hidden} more — call "load_skill" with a query to search by task.`);
  }
  const content = lines.join("\n");
  return {
    content,
    label: "skills catalog",
    priority: "normal",
    essential: false,
    estimatedTokens: estimateTokens(content),
    degraded: hidden > 0 ? { reason: `${hidden} more skills not listed` } : undefined,
  };
}

/** Блок тел загруженных скиллов (низкий приоритет, хвост промпта). */
export function buildLoadedBlock(loaded: SkillMeta[]): PromptBlock | null {
  if (loaded.length === 0) return null;
  const lines = ["[Loaded Skills]"];
  for (const skill of loaded) {
    lines.push(`--- ${skill.name} ---`);
    lines.push(skill.content);
    lines.push("");
  }
  const content = lines.join("\n");
  return {
    content,
    label: "loaded skills",
    priority: "low",
    essential: false,
    estimatedTokens: estimateTokens(content),
    tail: true,
  };
}
