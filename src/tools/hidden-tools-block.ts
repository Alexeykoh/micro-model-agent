/** Блоки системного промпта о доступности тулов: исполняемая схема vs знание. */
import type { ToolDefinition } from "./types";
import { filterToolsWithOverrides } from "./filter-tools";

/** Счётчики доступности, согласованные с селектором схемы. */
export interface ToolCounts {
  active: number;
  hidden: number;
  total: number;
}

/** Per-session переопределения тулов (mma web → Tools). */
export type ToolOverrides = { enabled?: string[]; disabled?: string[] };

/** Счётчики active/hidden/total для одного и того же набора тулов. */
export function hiddenToolCounts(
  allTools: ToolDefinition[],
  activeTags: string[],
  overrides?: ToolOverrides,
): ToolCounts {
  const visible = new Set(
    filterToolsWithOverrides(allTools, activeTags, overrides).map((t) => t.name),
  ).size;
  return { active: visible, hidden: allTools.length - visible, total: allTools.length };
}

/**
 * Exposition + strategy + worked examples для ответов модели про инструменты.
 *
 * Это essential-блок: даже если каталог выброшен бюджетом, модель знает,
 * что вызывать можно только схемы и как получить недостающий capability.
 */
export function buildToolContractBlock(counts: ToolCounts): string {
  return [
    "TOOL AVAILABILITY — READ ONCE",
    "The only tools you can CALL are the JSON function schemas sent with this request.",
    "Catalog below is KNOWLEDGE: locked, not callable. Count only schemas.",
    `IF asked "what tools do you have?" → "${counts.active} callable now; ${counts.hidden} on request via enable_tools".`,
    "Never list locked names as owned.",
    "Categories from schemas only — never from the catalog.",
    "IF you need a locked capability → enable_tools with its tag;",
    "schema appears NEXT iteration (same turn).",
    'Example: "weather in Moscow" → enable_tools ["web"] →',
    "next iteration web_search → answer from fetched facts.",
    "IF asked to use a locked name → say it is locked and enable it;",
    "never pretend you called it.",
    "IF a tool is disabled by the user → treat it as locked.",
  ].join("\n");
}

/**
 * Компактный каталог заблокированных тулов, сгруппированный по тегу.
 * Имя тула встречается ровно один раз: дубли по тегам раньше давали
 * неверный счёт у 9B моделей. Пустые теги (legacy «все тулы») — блок не нужен.
 */
export function buildHiddenToolsBlock(
  allTools: ToolDefinition[],
  activeTags: string[],
  overrides?: ToolOverrides,
): string {
  if (!allTools.length || activeTags.length === 0) return "";

  const visible = new Set(
    filterToolsWithOverrides(allTools, activeTags, overrides).map((t) => t.name),
  );
  const hidden = allTools.filter((tool) => !visible.has(tool.name));
  if (hidden.length === 0) return "";

  const groups = new Map<string, string[]>();
  for (const tool of hidden) {
    const tag = tool.tags?.[0] ?? "other";
    const names = groups.get(tag) ?? [];
    names.push(tool.name);
    groups.set(tag, names);
  }

  const lines = ["LOCKED CATALOG (knowledge, not callable — enable with enable_tools first):"];
  for (const [tag, names] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`- locked ${tag}: ${[...names].sort().join(", ")}`);
  }
  return lines.join("\n");
}
