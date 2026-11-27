/** Блок системного промпта о скрытых tag-фильтром тулах. */
import type { ToolDefinition } from "./types";

/**
 * Модельный заголовок — английский, без локали пользователя. Это не справочник,
 * а явное правило: имена ниже НЕ в tool-схеме, сначала enable_tools. Один рабочий
 * пример дешевле, чем попытка выдать модели полный каталог из 55 схем.
 */
function hiddenToolsHeader(active: number, hidden: number): string {
  const total = active + hidden;
  return [
    `Additional tools — ${active} active, ${hidden} hidden (${total} total). Names below are NOT in your tool list:`,
    "do not call them and do not describe them as available. To use one, call enable_tools with",
    "its tag; its schema appears from the NEXT turn. Example: need web_search →",
    'enable_tools ["web"] → next turn call web_search. If asked how many tools you have:',
    `${total} total, ${active} active, ${hidden} hidden; count each name once — bracketed tags`,
    "are enable paths, not separate tools.",
  ].join("\n");
}

/** Один скрытый тул = одна строка со всеми тегами, без дублей по тегам. */
interface HiddenRow {
  name: string;
  tags: string[];
}

/**
 * Компактный блок системного промпта со скрытыми тулами. Модель должна знать
 * об их существовании и пути доступа, но НЕ принимать их за доступные: каждый
 * тул печатается один раз со всеми тегами.
 * Пустой набор тегов — легаси «все тулы» (getAllForLLM на пустых отдаёт всё):
 * скрытых нет, блок не нужен. Раньше тут перечислялись тулы, которые уже
 * были в схеме, — модель зря дёргала enable_tools (L4).
 */
export function buildHiddenToolsBlock(allTools: ToolDefinition[], activeTags: string[]): string {
  if (!allTools.length || activeTags.length === 0) return "";

  const activeSet = new Set(activeTags);
  const visible = new Set<string>();
  for (const tool of allTools) {
    if (tool.alwaysOn || (tool.tags?.some((tag) => activeSet.has(tag)))) {
      visible.add(tool.name);
    }
  }

  const hidden = allTools.filter((tool) => !visible.has(tool.name));
  if (hidden.length === 0) return "";

  // Раньше тул с несколькими тегами печатался в каждой группе — 9B модель
  // считала его дважды и приходила к неверному числу инструментов. Теперь
  // каждый тул встречается ровно один раз, теги перечислены в этой строке.
  const rows = new Map<string, HiddenRow>();
  for (const tool of hidden) {
    const tags = tool.tags && tool.tags.length > 0 ? tool.tags : ["other"];
    const row = rows.get(tool.name);
    if (!row) {
      rows.set(tool.name, { name: tool.name, tags: [...tags] });
      continue;
    }
    for (const tag of tags) {
      if (!row.tags.includes(tag)) row.tags.push(tag);
    }
  }

  const lines: string[] = [hiddenToolsHeader(visible.size, hidden.length)];
  for (const row of [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`- ${row.name} [${row.tags.join(", ")}]`);
  }

  return lines.join("\n");
}
