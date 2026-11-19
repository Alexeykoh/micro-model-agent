// Sink DLP-egress диагностик (INV-15) — вынесен из `tool-context.ts`
// (правило ≤300). `recordEgressTurn` ведёт журнал вызовов на ход, синк пишет
// штатную редакцию/блок/деградацию в активную сессию и в «Безопасность».
import type { SessionManager } from "../../modules/session/index";
import type { GuardDiagnostic } from "../../modules/security/data-policy/types";
import { recordEgressTurn } from "../../modules/security/data-policy/turn-journal";
import { emitSecurityEvent } from "../../modules/security/security-events";
import { logAudit } from "../../modules/security/audit-log";

/**
 * Сигнал DLP-egress (INV-15): `aborted` — fail-closed прервал вызов,
 * `degraded` — осознанный fail-open. Пишется в лог активной сессии; `redacted`
 * (штатная редакция) — тоже оставляет след, но только когда редакция
 * **необратима** (класс `secret`): псевдонимизированные пути/PII восстанавливаются
 * и дают запись на каждый вызов LLM, их счётчик живёт в бейдже webui (INV-DLP-2).
 *
 * Маршрутизация — по `diag.sessionId`, который штампует фабрика guard'а: sink
 * остаётся процесс-глобальным, а параллельные сессии больше не смешиваются.
 */

/**
 * Подпись последней DLP-редакции на сессию. LLM делает несколько вызовов за
 * ход; один и тот же профиль (операция + классы) не должен повторяться в
 * журнале защиты на каждый вызов. Появился новый класс — событие снова видно.
 */
const dlpSeen = new Map<string, string>();

/** Сводка классов без значений: `path×2, pii×1`. */
function statsLabel(stats: GuardDiagnostic["stats"]): string {
  return Object.entries(stats ?? {})
    .filter(([, count]) => (count ?? 0) > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cls, count]) => `${cls}×${count}`)
    .join(", ");
}

export function egressDiagnosticSink(
  sessionManager: SessionManager,
): (diag: GuardDiagnostic) => void {
  return (diag: GuardDiagnostic) => {
    recordEgressTurn(diag);
    if (diag.outcome === "redacted") {
      // INV-S4: необратимая редакция видна в `session.jsonl` — только метаданные
      // (счётчик и вид цели), без оригиналов и без token id (INV-DLP-1).
      const secrets = diag.stats?.secret ?? 0;
      if (secrets > 0) {
        sessionManager.appendLog({
          ts: new Date().toISOString(),
          type: "egress_redacted",
          content: `DLP: отредактировано секретов — ${secrets}${egressTargetSuffix(diag.target)}`,
          source: "module:security.data-policy",
          module: "security.data-policy",
          operation: diag.operation,
        });
      }
      // В журнал «Безопасность» → DLP попадает КАЖДАЯ редакция (пути, PII,
      // секреты), а не только секреты: иначе подкладка DLP пуста при обычной
      // редакции путей/PII, хотя бейдж DLP в ленте показывает находки.
      const label = statsLabel(diag.stats);
      if (label) {
        const sessionKey = diag.sessionId ?? "global";
        const signature = `${diag.operation}|${label}`;
        if (dlpSeen.get(sessionKey) !== signature) {
          dlpSeen.set(sessionKey, signature);
          // audit.jsonl — источник истории для журнала после перезагрузки.
          logAudit({
            timestamp: new Date().toISOString(),
            ...(diag.sessionId ? { sessionId: diag.sessionId } : {}),
            action: "dlp_redaction",
            tool: diag.operation,
            success: true,
            details: `${label}${egressTargetSuffix(diag.target)}`,
            ...(secrets > 0 ? { reason: "secret redacted" } : {}),
          });
        }
      }
      return;
    }
    const blocked = diag.outcome === "aborted";
    sessionManager.appendLog({
      ts: new Date().toISOString(),
      type: blocked ? "egress_blocked" : "egress_degraded",
      content: diag.cause ?? diag.operation,
      source: "module:security.data-policy",
      module: "security.data-policy",
      operation: diag.operation,
      errorKind: blocked ? "blocked" : "degraded",
      cause: diag.cause,
      recoverable: !blocked,
    });
    emitSecurityEvent({
      ts: new Date().toISOString(),
      class: "dlp",
      severity: blocked ? "high" : "medium",
      summary: blocked ? "DLP: вызов прерван" : "DLP: fail-open",
      action: blocked ? "egress_blocked" : "egress_degraded",
      success: !blocked,
      ...(diag.sessionId ? { sessionId: diag.sessionId } : {}),
      tool: diag.operation,
      ...(diag.cause ? { reason: diag.cause } : {}),
    });
  };
}

/** Вид цели для журнала редакции: хост и доверие (без путей и значений). */
function egressTargetSuffix(target: GuardDiagnostic["target"]): string {
  if (target?.kind !== "provider") return "";
  const host = target.host ?? "?";
  return ` (провайдер: ${host}, ${target.trusted ? "доверенный" : "внешний"})`;
}
