/**
 * Типизированный event-envelope v1 и per-session лог для resume.
 *
 * `seq` монотонный на сессию, переживает переподключение (SSE `id:` →
 * `Last-Event-ID`). Лог — in-memory ring: durability между рестартами процесса
 * best-effort, источник правды статуса задачи — `GET /v1/tasks/:jobId` (спека §7.3, §8.3).
 */

/** Событие потока v1. Additive-only в рамках v1 (спека §7.1). */
export interface Envelope {
  v: 1;
  seq: number;
  ts: number;
  type: string;
  sessionId: string;
  taskId?: string;
  data: unknown;
}

/** Bounded per-session буфер envelope'ов с монотонным seq. */
export class EnvelopeLog {
  private seqs = new Map<string, number>();
  private logs = new Map<string, Envelope[]>();

  constructor(private readonly cap = 2000) {}

  /** Следующий seq для сессии (монотонный, начиная с 1). */
  next(sessionId: string): number {
    const n = (this.seqs.get(sessionId) ?? 0) + 1;
    this.seqs.set(sessionId, n);
    return n;
  }

  /** Кладёт готовый envelope в буфер, вытесняя самый старый при переполнении. */
  append(env: Envelope): void {
    const arr = this.logs.get(env.sessionId) ?? [];
    arr.push(env);
    if (arr.length > this.cap) arr.splice(0, arr.length - this.cap);
    this.logs.set(env.sessionId, arr);
  }

  /** Envelope'ы сессии со `seq` строго больше переданного (для resume). */
  since(sessionId: string, seq: number): Envelope[] {
    return (this.logs.get(sessionId) ?? []).filter((e) => e.seq > seq);
  }

  /** Сброс буфера одной сессии или всего (id сессии удалён). */
  clear(sessionId?: string): void {
    if (sessionId === undefined) {
      this.logs.clear();
      this.seqs.clear();
      return;
    }
    this.logs.delete(sessionId);
    this.seqs.delete(sessionId);
  }
}
