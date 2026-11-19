/**
 * Журнал защиты сессии (split W10): общий для локального веба и демона.
 *
 * Источники: кольцевой буфер процесса (живые события) и `audit.jsonl`
 * **каталога этой сессии** (история, переживает перезапуск). Глобальный
 * `~/.mma/logs/audit.jsonl` не читаем: там записи всех сессий, журнал одной
 * вкладки смешался бы с чужими. Дубли снимаются по (ts, action, цель).
 */
import { readFileSync } from "node:fs";
import { auditLogFile } from "../config/paths";
import {
  securityEventFromAudit,
  securityEventsFor,
  type AuditLike,
  type SecurityEvent,
} from "../modules/security/security-events";

/** Сколько событий отдавать по умолчанию и максимум. */
export const DEFAULT_SECURITY_LIMIT = 100;
export const MAX_SECURITY_LIMIT = 200;

/** Прочитать security-события из `audit.jsonl` каталога сессии (best-effort). */
function readAuditEvents(sessionDir: string, sessionId: string): SecurityEvent[] {
  try {
    const text = readFileSync(auditLogFile(sessionDir), "utf8");
    const out: SecurityEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as AuditLike;
        const ev = securityEventFromAudit(entry);
        if (ev) out.push({ ...ev, sessionId });
      } catch {
        /* битая строка аудита не ломает ответ */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Ключ дедупликации: событие в буфере и в аудите — одно и то же. */
function eventKey(ev: SecurityEvent): string {
  return [ev.ts, ev.action, ev.tool ?? "", ev.url ?? ev.path ?? ev.command ?? ""].join("\0");
}

/** Слить буфер и историю: хронологически, без дублей, хвост по лимиту. */
export function mergeSecurityEvents(
  sessionId: string,
  limit: number,
  sessionDir?: string,
): SecurityEvent[] {
  const seen = new Set<string>();
  const merged: SecurityEvent[] = [];
  const history = sessionDir ? readAuditEvents(sessionDir, sessionId) : [];
  for (const ev of [...history, ...securityEventsFor(sessionId)]) {
    const key = eventKey(ev);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ev);
  }
  merged.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}

/** Нормализует `?limit=` в допустимый хвост (дефолт и потолок общие). */
export function clampSecurityLimit(raw?: string | null): number {
  const parsed = raw ? Number(raw) : DEFAULT_SECURITY_LIMIT;
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), MAX_SECURITY_LIMIT)
    : DEFAULT_SECURITY_LIMIT;
}
