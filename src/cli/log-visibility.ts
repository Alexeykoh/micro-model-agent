// Видимость структурных info-логов и диагностики: один шов для всех веток CLI.
import { getDefaultChannel } from "../output";

/**
 * Quiet-чат прячет структурные info-логи; `--verbose` (или verbose-конфиг) их
 * возвращает. Диагностика петли (`Logger.diagnostic`) следует тому же правилу.
 *
 * Вызывается до `bootstrap` (чтобы его собственные логи уважали флаг) и повторно
 * после — уже с учётом конфига.
 */
export function applyLogVisibility(verbose: boolean): void {
  getDefaultChannel().setSuppressInfoLogs(!verbose);
  getDefaultChannel().setShowDiagnostics(verbose);
}
