// Класс причины неисправности LSP-сервера — единственный источник правды для
// `/lsp doctor` и actionable-подсказок в `[LSP check failed]`.
//
// Вынесено из `diagnose-server.ts` (правило 6): таблицу причин читают и
// диагностика, и подсказки установки, и health — это отдельный шов.
import { looksLikeNodeVersionCrash } from "./node-version";

export type LspFailureReason =
  | "ok"
  | "disabled"
  | "not-applicable"
  | "binary-missing"
  | "offline"
  | "network"
  | "timeout"
  | "spawn-failed"
  | "node-too-old"
  | "server-error"
  | "deadline";

/**
 * Классифицировать ошибку запуска/инициализации LSP-сервера. Вынесено отдельно,
 * чтобы doctor и failure-путь модуля считали одинаково.
 *
 * `node-too-old` — крах JS-сервера на неподходящем рантайме (Node 16 с
 * `typescript-language-server` 4+: `SyntaxError`/`ERR_REQUIRE_ESM` до
 * `initialize`). Раньше такой крах попадал в общий `server-error`, и совет
 * «поставь сервер глобально» воспроизводил ту же поломку.
 *
 * Проверяется **до** таймаута: сервер, который упал, отвечает клиенту не
 * ошибкой рантайма, а «connection closed»/«request timeout». Настоящая причина
 * остаётся только в stderr, и вызывающий склеивает её с сообщением.
 */
export function classifyLspError(
  message: string,
  opts: { npxFallback?: boolean } = {},
): LspFailureReason {
  if (/MMA_LSP_OFFLINE|auto-install is disabled/i.test(message)) return "offline";
  if (/not found/i.test(message)) return "binary-missing";
  if (/ENOENT|EINVAL|\bspawn\b/i.test(message)) return "spawn-failed";
  if (looksLikeNodeVersionCrash(message)) return "node-too-old";
  if (/timeout/i.test(message)) return opts.npxFallback ? "network" : "timeout";
  return "server-error";
}
