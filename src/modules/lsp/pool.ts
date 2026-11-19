// Пул тёплых LSP-соединений: одно соединение на `(сервер, корень проекта)`,
// живущее всю сессию. Отсюда берёт соединения фасад `client.ts`.
//
// Зачем: прежде каждый checkFile спавнил и убивал процесс сервера, так что
// индекс language server'а не переживал ни одной правки. Пул держит соединение
// живым, ограничивает их число (LRU), режет простаивающие (idle) и пересоздаёт
// те, что умерли сами.
import { LspConnection, poolKey, type LspConnectionDeps, type LspPoolDeps } from "./connection";
import type { LspExitInfo, LspProbeError } from "./connection-types";
import type { LspServerConfig } from "./types";
import { LSP_MAX_SERVERS, LSP_SERVER_IDLE_MS, LSP_IDLE_SWEEP_MS } from "../../config/timeouts";

/** Настройки пула: пределы и TTL. */
export interface LspPoolOptions {
  /** Максимум живых соединений (LRU-вытеснение). */
  maxServers?: number;
  /** Сколько соединение может простаивать до закрытия. */
  idleMs?: number;
  /** Интервал проверки простоя. */
  sweepMs?: number;
  /** Источник времени (тесты). */
  now?: () => number;
  /** setInterval/clearInterval (тесты). */
  sweepScheduler?: Pick<typeof globalThis, "setInterval" | "clearInterval">;
}

/** Что пул сообщает о себе для `/lsp status` и тестов. */
export interface LspPoolStats {
  live: number;
  /** Сколько соединений пересоздано после самопроизвольной смерти сервера. */
  restarts: number;
  /** Сколько соединений закрыто простоем или LRU-вытеснением. */
  reaped: number;
}

export class LspConnectionPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly inflight = new Map<string, Promise<LspConnection>>();
  /** Как завершился последний процесс по ключу (код/сигнал) — для отчётов. */
  private readonly exits = new Map<string, LspExitInfo>();
  private readonly maxServers: number;
  private readonly idleMs: number;
  private readonly sweepMs: number;
  private readonly now: () => number;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;
  private sweep: ReturnType<typeof setInterval> | null = null;
  private restarts = 0;
  private reaped = 0;
  private disposed = false;

  constructor(
    private readonly deps: LspPoolDeps = {},
    options: LspPoolOptions = {},
  ) {
    this.maxServers = Math.max(1, options.maxServers ?? LSP_MAX_SERVERS);
    this.idleMs = options.idleMs ?? LSP_SERVER_IDLE_MS;
    this.sweepMs = Math.max(100, options.sweepMs ?? LSP_IDLE_SWEEP_MS);
    this.now = options.now ?? (() => Date.now());
    const scheduler = options.sweepScheduler ?? globalThis;
    this.setIntervalFn = scheduler.setInterval.bind(globalThis);
    this.clearIntervalFn = scheduler.clearInterval.bind(globalThis);
  }

  stats(): LspPoolStats {
    return { live: this.entries.size, restarts: this.restarts, reaped: this.reaped };
  }

  /** Живые ключи соединений (для тестов и статуса). */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Что реально поднято: сервер, корень проекта и возраст соединения.
   * Ответ на «сервер поднялся?» без догадок: пул — единственный источник правды.
   */
  keyStates(): Array<{ key: string; root: string; ageMs: number }> {
    const now = this.now();
    return [...this.entries.values()].map((entry) => ({
      key: entry.connection.key.split("\u0000")[0] ?? entry.connection.key,
      root: entry.projectRoot,
      ageMs: Math.max(0, now - entry.openedAt),
    }));
  }
  /** Соединение-депы для конкретного соединения: часы — из пула. */
  private connectionDeps(): LspConnectionDeps {
    return { ...this.deps, now: this.now };
  }

  /** Поднять таймер простоя. Безынерционен: повторный вызов ничего не ломает. */
  startSweep(): void {
    if (this.disposed || this.sweep) return;
    this.sweep = this.setIntervalFn(() => {
      void this.reapIdle();
    }, this.sweepMs);
    // Таймер не должен держать процесс живым после закрытия сессии.
    (this.sweep as { unref?: () => void }).unref?.();
  }

  /**
   * Соединение для `(serverKey, projectRoot)`. Создаётся при первом
   * обращении; конкурентные вызова получают один и тот же промис. Мёртвое
   * соединение (сервер сам умер) выбрасывается и поднимается заново.
   */
  async acquire(serverKey: string, server: LspServerConfig, projectRoot: string): Promise<LspConnection> {
    this.startSweep();
    const id = poolKey(serverKey, projectRoot);
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.connection.isOpen) {
        existing.connection.touch();
        return existing.connection;
      }
      this.rememberExit(id, existing.connection);
      this.entries.delete(id);
      this.restarts++;
    }
    const pending = this.inflight.get(id);
    if (pending) return pending;

    const created = (async () => {
      const connection = new LspConnection(serverKey, projectRoot, server, this.connectionDeps());
      try {
        await connection.open();
      } catch (e) {
        // Причина краха часто есть только в stderr процесса: сервер падает до
        // `initialize`, а клиент видит «connection closed». Пробрасываем хвост
        // дальше, чтобы `[LSP check failed]` не был пустым.
        const failure = e as LspProbeError;
        if (!failure.stderrTail) failure.stderrTail = connection.stderrTail;
        throw failure;
      }
      if (this.disposed) {
        await connection.shutdown();
        throw new Error("LSP pool disposed");
      }
      this.entries.set(id, { connection, projectRoot, openedAt: this.now() });
      this.exits.delete(id);
      this.evictOverflow();
      return connection;
    })();

    this.inflight.set(id, created);
    try {
      return await created;
    } finally {
      this.inflight.delete(id);
    }
  }

  /** Достать живое соединение, если оно уже есть (без спавна). */
  peek(serverKey: string, projectRoot: string): LspConnection | null {
    const id = poolKey(serverKey, projectRoot);
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.connection.isOpen) return entry.connection;
    // Соединение умерло само: запоминаем код выхода, чтобы отчёт сказал, что
    // это был за выход (0/1/сигнал), а не «сервер exited» без деталей.
    this.rememberExit(id, entry.connection);
    this.entries.delete(id);
    return null;
  }

  /** Код/сигнал последнего завершения сервера по ключу (null — не падал). */
  lastExit(serverKey: string, projectRoot: string): LspExitInfo | null {
    return this.exits.get(poolKey(serverKey, projectRoot)) ?? null;
  }

  /** Запомнить код завершения умершего соединения. */
  private rememberExit(id: string, connection: LspConnection): void {
    const exit = connection.lastExit;
    if (exit) this.exits.set(id, exit);
  }


  /** Закрыть конкретное соединение (смена конфига сервера, `/lsp restart`). */
  async close(serverKey: string, projectRoot: string): Promise<void> {
    const id = poolKey(serverKey, projectRoot);
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.reaped++;
    await entry.connection.shutdown();
  }

  /** Закрыть все соединения и снять таймер. Идемпотентно. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweep) {
      this.clearIntervalFn(this.sweep);
      this.sweep = null;
    }
    const all = [...this.entries.values()];
    this.entries.clear();
    // Последовательно: параллельные killTree цепляются за общий taskkill.
    for (const entry of all) {
      await entry.connection.shutdown();
    }
  }

  /**
   * Закрыть простаивающие дольше `idleMs` соединения. Публичный: вызывается
   * таймером пула и в тестах (виртуальные часы вместо ожидания).
   */
  async reapIdle(): Promise<void> {
    const now = this.now();
    for (const [key, entry] of [...this.entries]) {
      if (entry.connection.idleFor(now) > this.idleMs) {
        this.entries.delete(key);
        this.reaped++;
        await entry.connection.shutdown();
      }
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxServers) {
      const now = this.now();
      // Жертва — самый давно использованный (максимальный idle), поэтому
      // сортировка по убыванию idle.
      const victim = [...this.entries.entries()].sort(
        (a, b) => b[1].connection.idleFor(now) - a[1].connection.idleFor(now),
      )[0];
      if (!victim) return;
      this.entries.delete(victim[0]);
      this.reaped++;
      void victim[1].connection.shutdown();
    }
  }
}

interface PoolEntry {
  connection: LspConnection;
  projectRoot: string;
  /** Когда соединение поднялось (для `/lsp status`: возраст). */
  openedAt: number;
}
