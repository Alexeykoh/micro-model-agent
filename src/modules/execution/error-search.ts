/**
 * Автопоиск ошибки в вебе (`execution/module.ts`, INV-23): при повторяющейся
 * ошибке тула — поисковый запрос по контексту и инжект результатов в контекст.
 * Вынесено из класса `ExecutionModule`.
 */
import type { ToolContext, ToolCall } from "../../tools/types";
import type { StuckDetector } from "./stuck-detector";
import { isSearchableError, buildSearchQuery } from "./stuck-detector";
import type { PlanTracker } from "./tracker";
import type { WebSearchRunner } from "./module";
import { getSessionSecurityConfig } from "../security/session-isolation";
import { t } from "../../i18n/index";

/** Мутабельный вид `ExecutionModule`, которым владеет автопоиск ошибок. */
export interface ErrorSearchHost {
  stuckDetector: StuckDetector;
  tracker: PlanTracker | null;
  pendingMessages: Array<{ role: "user"; content: string }>;
  retrySignatures: Set<string>;
  searchRunner: WebSearchRunner;
  errorSearchCooldownMs: number;
  searchesThisSession: number;
  lastErrorSearchAt: number;
  setSearchesThisSession(n: number): void;
  setLastErrorSearchAt(n: number): void;
}

/** Запускает веб-поиск по повторяющейся ошибке тула (best-effort, не блокирует). */
export function maybeSearchError(host: ErrorSearchHost, ctx: ToolContext, call: ToolCall): void {
  if (ctx.config?.webSearch?.enabled === false) return;
  const cfg = ctx.config?.errorWebSearch;
  if (!cfg?.enabled) return;
  const sig = host.stuckDetector.getRepeatedErrorSignature();
  if (!sig) return;
  if (host.stuckDetector.hasErrorSearched(sig) && !host.retrySignatures.has(sig)) return;
  if (host.searchesThisSession >= (cfg.maxSearchesPerSession ?? 3)) return;
  const lastError = host.stuckDetector.getLastErrorOutput();
  if (!isSearchableError(lastError)) {
    ctx.logger?.debug(t("exec.error_search_no_query"));
    return;
  }
  const now = Date.now();
  if (now - host.lastErrorSearchAt < host.errorSearchCooldownMs) return;
  const stepDesc = host.tracker?.getCurrentStep()?.description ?? "";
  const query = buildSearchQuery(
    stepDesc,
    host.stuckDetector.getLastBashCommand(),
    lastError,
    call.name,
    cfg.maxQueryChars ?? 200,
  );
  const count = host.stuckDetector.getErrorSignatureCount(sig);
  host.stuckDetector.markErrorSearched(sig);
  host.setSearchesThisSession(host.searchesThisSession + 1);
  host.setLastErrorSearchAt(now);
  const networkConfig = getSessionSecurityConfig(ctx.config, ctx.sessionContext).network;
  host
    .searchRunner(query, cfg.maxResults ?? 5, networkConfig, cfg.requestTimeoutMs ?? 10000)
    .then((res) => {
      if (!res.success || res.results.length === 0) {
        if (!host.retrySignatures.has(sig)) {
          host.retrySignatures.add(sig);
          host.stuckDetector.unmarkErrorSearched(sig);
        }
        ctx.logger?.warn(t("exec.error_search_failed", { query }));
        ctx.sessionLog?.plan("web-search", `empty/failed: ${query}`);
        return;
      }
      const resultsText = res.results
        .map((r, i) => `${i + 1}. ${r.title} \u2014 ${r.url}\n   ${r.snippet}`)
        .join("\n");
      host.pendingMessages.push({
        role: "user",
        content: `<system-summary>${t("exec.error_search_results", {
          sig,
          count: String(count),
          query,
          results: resultsText,
        })}</system-summary>`,
      });
    })
    .catch((e) => ctx.logger?.warn(`error web search: ${e.message}`));
}
