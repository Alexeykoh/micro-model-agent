// Инструмент `project_map`: схема, диспетчер действий и их реализация.
//
// Вынесено из `module.ts`: это презентация индекса, а не его состояние
// (правило 6 AGENTS). Модуль отдаёт узкий `MapToolHost`, поэтому кэш,
// вотчер и приватные поля сюда не проникают.
import type { ToolDefinition, ToolContext, ToolResult } from "../../tools/types";
import type { IndexResult } from "./walker";
import type { SymbolLocationHit, SymbolProvider } from "./provider";
import { buildProjectProfileLine } from "./project-profile";
import { formatLspSymbols } from "./format";
import { t } from "../../i18n/index";

/** Что инструменту нужно от модуля (публичный срез, без внутреннего состояния). */
export interface MapToolHost {
  baseDir: string;
  buildIndex(): Promise<IndexResult | null>;
  refresh(): Promise<IndexResult | null>;
  getIndex(): IndexResult | null;
  summarize(result: IndexResult): string;
  hasIndexedSymbols(query: string): boolean;
  getSymbolProvider(): SymbolProvider | null;
  preferredLanguage(): string;
  formatFind(query: string): string;
  formatSymbols(query: string): string;
  formatOutline(query: string): string;
}

/** Описание тула `project_map`. */
export function createProjectMapTool(host: MapToolHost): ToolDefinition {
  return {
    name: "project_map",
    security: { caps: [{ fs: "read" }] },
    icon: "🗺️",
    alwaysOn: true,
    description: t("indexer.project_map_desc"),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["summary", "refresh", "find", "symbol", "outline"],
          description: t("indexer.project_map_action_desc"),
        },
        query: {
          type: "string",
          description: t("indexer.project_map_query_desc"),
        },
      },
      required: ["action"],
    },
    handler: async (_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> =>
      runProjectMapAction(host, String(args.action || "summary"), String(args.query || "")),
  };
}

/** Диспетчер действий `project_map` (handler-map, правило #17). */
function runProjectMapAction(
  host: MapToolHost,
  action: string,
  rawQuery: string,
): Promise<ToolResult> | ToolResult {
  const query = rawQuery.trim();
  switch (action) {
    case "refresh":
      return refreshMap(host);
    case "find":
      return queryResult(host, query, () => host.formatFind(query));
    case "symbol":
      return symbolResult(host, query);
    case "outline":
      return queryResult(host, query, () => host.formatOutline(query));
    default:
      return summaryMap(host);
  }
}

/** `refresh`: пересборка индекса + сводка и профиль стека. */
async function refreshMap(host: MapToolHost): Promise<ToolResult> {
  const result = await host.refresh();
  const summary = result ? host.summarize(result) : t("indexer.empty");
  const stackLine = result ? buildProjectProfileLine(host.baseDir) : null;
  const output = summary && stackLine ? `${summary}\n${stackLine}` : summary;
  return makeResult(t("indexer.refreshed", { summary: output }));
}

/** `summary`: гарантирует индекс и отдаёт сводку + профиль стека. */
async function summaryMap(host: MapToolHost): Promise<ToolResult> {
  let index = host.getIndex();
  if (!index) {
    await host.buildIndex();
    index = host.getIndex();
  }
  if (!index) return makeResult(t("indexer.not_indexed"));
  const summary = host.summarize(index);
  const stackLine = buildProjectProfileLine(host.baseDir);
  const output = summary && stackLine ? `${summary}\n${stackLine}` : summary;
  return makeResult(t("indexer.summary", { summary: output }));
}

/**
 * `symbol`: сначала индекс (быстро, без процессов). Если совпадений нет —
 * запрашивает внешний провайдер (LSP `workspace/symbol`) и форматирует его
 * локации; ошибка/пусто → откат на индексный ответ.
 */
async function symbolResult(host: MapToolHost, query: string): Promise<ToolResult> {
  if (!query) return { success: false, output: t("tool.invalid_params") };
  if (!host.getIndex()) await host.buildIndex();
  if (host.hasIndexedSymbols(query)) return makeResult(host.formatSymbols(query));
  const provider = host.getSymbolProvider();
  if (provider) {
    const language = host.preferredLanguage();
    let hits: SymbolLocationHit[] = [];
    try {
      hits = await provider(query, language);
    } catch {
      hits = [];
    }
    if (hits.length > 0) return makeResult(formatLspSymbols(hits));
  }
  if (!host.getIndex()) return makeResult(t("indexer.not_indexed"));
  return makeResult(host.formatSymbols(query));
}

/** Поисковое действие: проверяет запрос и индекс, отдаёт готовый текст. */
async function queryResult(
  host: MapToolHost,
  query: string,
  format: () => string,
): Promise<ToolResult> {
  if (!query) return { success: false, output: t("tool.invalid_params") };
  if (!host.getIndex()) await host.buildIndex();
  if (!host.getIndex()) return makeResult(t("indexer.not_indexed"));
  return makeResult(format());
}

function makeResult(output: string): ToolResult {
  return { success: true, output, display: output };
}
