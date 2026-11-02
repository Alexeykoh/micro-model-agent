/**
 * Внутрипроцессный поток security-событий (U22): быстрый журнал «что поймала
 * защита» для вкладки «Безопасность» в `mma web`.
 *
 * Отдельно от `AuditNotifier`: тот пишет файл и webhook, по умолчанию выключен
 * и не умеет отдавать событие в UI. Здесь — кольцевой буфер на сессию (по
 * образцу Trace) + синхронные подписчики. Оригиналы секретов не проходят:
 * `details`/`reason` — уже редакция продюсера, а транспорт E2 фильтрует ещё раз.
 */

/** Класс перехвата в UI. */
export type SecurityClass = "block" | "approval" | "dlp" | "ssrf";

/** Уровень важности (как в audit-notifier, без его конфига). */
export type SecuritySeverity = "low" | "medium" | "high" | "critical";

/** Одно security-событие для журнала. */
export interface SecurityEvent {
  ts: string;
  /** Класс: что именно сработало. */
  class: SecurityClass;
  severity: SecuritySeverity;
  /** Короткая суть для строки журнала. */
  summary: string;
  /** Действие из аудита (`security_block`, `security_approval`, …). */
  action: string;
  success: boolean;
  sessionId?: string;
  tool?: string;
  path?: string;
  command?: string;
  url?: string;
  /** Причина отказа/редакции (без оригиналов секретов). */
  reason?: string;
  /** Дополнительные детали (счётчик, класс данных, хост). */
  details?: string;
  /** Стабильный id для сверки с Trace. */
  id?: string;
}

/** Кап кольцевого буфера на сессию (свежее вытесняет старое). */
export const SECURITY_EVENT_CAP = 200;

const buffers = new Map<string, SecurityEvent[]>();
const subscribers = new Set<(ev: SecurityEvent) => void>();
/** Сессия для «безымянных» событий (main/CLI), если продюсер её не назвал. */
let fallbackSession: string | null = null;

/** Задать сессию по умолчанию для событий без `sessionId`. */
export function setSecurityEventSession(sessionId: string | null): void {
  fallbackSession = sessionId;
}

/** Минимальная форма записи аудита (без импорта audit-log — нет цикла). */
export interface AuditLike {
  timestamp: string;
  sessionId?: string;
  action: string;
  tool?: string;
  path?: string;
  command?: string;
  url?: string;
  success: boolean;
  details?: string;
  reason?: string;
}

/** Короткая суть события: тул/путь/URL — без содержимого. */
function summaryOf(entry: AuditLike, cls: SecurityClass): string {
  const target = entry.url ?? entry.path ?? entry.command ?? entry.tool ?? "";
  const base =
    cls === "dlp" ? "DLP" : cls === "ssrf" ? "SSRF" : cls === "approval" ? "approval" : "block";
  return target ? `${base}: ${target}` : base;
}

/**
 * Запись аудита → security-событие журнала; `null` — не security-событие.
 * SSRF отличается от прочих блоков наличием URL: блок пути — не сетевой отказ.
 * Обычные сетевые ошибки (`network_request` failed) намеренно не попадают:
 * это не перехват защиты, а сбой сети, и он бы затопил журнал.
 */
export function securityEventFromAudit(entry: AuditLike): SecurityEvent | null {
  let cls: SecurityClass | null = null;
  if (entry.action === "security_block") cls = entry.url ? "ssrf" : "block";
  else if (entry.action === "security_approval") cls = "approval";
  if (!cls) return null;
  const severity: SecuritySeverity =
    cls === "ssrf" ? "high" : cls === "approval" ? "medium" : entry.success ? "low" : "medium";
  return {
    ts: entry.timestamp,
    class: cls,
    severity,
    summary: summaryOf(entry, cls),
    action: entry.action,
    success: entry.success,
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(entry.tool ? { tool: entry.tool } : {}),
    ...(entry.path ? { path: entry.path } : {}),
    ...(entry.command ? { command: entry.command } : {}),
    ...(entry.url ? { url: entry.url } : {}),
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.details ? { details: entry.details } : {}),
  };
}

/** Учесть событие: буфер сессии + подписчики. Никогда не бросает. */
export function emitSecurityEvent(ev: SecurityEvent): void {
  try {
    const sessionId = ev.sessionId ?? fallbackSession ?? undefined;
    const stored: SecurityEvent = { ...ev, ...(sessionId ? { sessionId } : {}) };
    if (sessionId) {
      const list = buffers.get(sessionId) ?? [];
      list.push(stored);
      // Свежее сверху: лишние вытесняем из головы.
      while (list.length > SECURITY_EVENT_CAP) list.shift();
      buffers.set(sessionId, list);
    }
    for (const fn of [...subscribers]) {
      try {
        fn(stored);
      } catch {
        /* подписчик не имеет права уронить продюсера */
      }
    }
  } catch {
    /* fail-open */
  }
}

/** Подписка на живые события; возвращает отписку. */
export function subscribeSecurityEvents(fn: (ev: SecurityEvent) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Буфер сессии (свежее — в конце, как пришло). */
export function securityEventsFor(sessionId: string, limit?: number): SecurityEvent[] {
  const list = buffers.get(sessionId) ?? [];
  if (limit === undefined || limit >= list.length) return [...list];
  return list.slice(list.length - limit);
}

/** Сброс буферов и подписчиков (только для тестов). */
export function resetSecurityEvents(): void {
  buffers.clear();
  subscribers.clear();
  fallbackSession = null;
}
