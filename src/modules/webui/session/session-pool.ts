/**
 * Per-session слоты прогонов для настоящего параллелизма (`mma web`).
 *
 * Один `Agent` — не reentrant, контекст/сессия/трекер — одни на процесс,
 * поэтому каждая одновременно бегущая сессия ходит своим раннером
 * (`SessionRunner` из bootstrap: свой агент/контекст/трекер/исполнитель).
 * Пул держит per-session single-flight (очередь + busy-флаг на сессию);
 * исполнение между сессиями — полностью параллельно, предел — только
 * провайдер и машина (как у Claude/Cursor — отдельного капа нет).
 *
 * Ключ "" — только тестовый/служебный слот без сессии (web-ходы всегда несут
 * сессию; фабрика обязательна). Сессии делят workspace (как два терминала
 * в одном каталоге): параллельные правки одних файлов могут конфликтовать —
 * worktree-изоляции пока нет.
 */
import type { SessionRunner } from "../../../core/bootstrap/session-runner";
import type { QueuedMessage } from "../state";
import { MAX_QUEUE_LENGTH } from "../limits";

/** Слот сессии: busy-резерв с токеном владения + FIFO входящих. */
export interface RunSlot {
  busy: boolean;
  token: object | null;
  queue: QueuedMessage[];
}

/** Фабрика раннеров из bootstrap (нет — legacy-режим без параллелизма). */
export type RunnerFactory = (sessionId: string) => SessionRunner;

/** Per-session пул: очереди, busy-слоты, кеш раннеров. Чистое состояние — IO в util. */
export class RunPool {
  private slots = new Map<string, RunSlot>();
  private runners = new Map<string, SessionRunner>();
  private factory?: RunnerFactory;

  constructor(factory?: RunnerFactory) {
    if (factory) this.factory = factory;
  }

  /** Поздняя привязка фабрики (state создаётся раньше module). */
  setFactory(factory: RunnerFactory): void {
    this.factory = factory;
  }

  /** Есть ли фабрика (фабричный режим с параллелизмом vs legacy). */
  hasFactory(): boolean {
    return this.factory !== undefined;
  }

  /** Ключ слота: sessionId или "" для legacy. */
  static key(id: string | null): string {
    return id ?? "";
  }

  private slotFor(id: string | null): RunSlot {
    const key = RunPool.key(id);
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { busy: false, token: null, queue: [] };
      this.slots.set(key, slot);
    }
    return slot;
  }

  /** Занят ли слот (идёт ход). */
  isBusy(id: string | null): boolean {
    return this.slotFor(id).busy;
  }

  /** Id занятых сессионных слотов (без legacy — для бейджей вкладок). */
  busyIds(): string[] {
    const out: string[] = [];
    for (const [key, slot] of this.slots) {
      if (key !== "" && slot.busy) out.push(key);
    }
    return out;
  }

  /** Занят ли хоть один слот (агрегат для legacy `s.busy`). */
  anyBusy(): boolean {
    for (const slot of this.slots.values()) {
      if (slot.busy) return true;
    }
    return false;
  }

  /** Счётчики очереди по сессиям (без legacy — для бейджей). */
  queuedCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, slot] of this.slots) {
      if (key === "") continue;
      if (slot.queue.length > 0) out[key] = slot.queue.length;
    }
    return out;
  }

  /** Длина всех очередей (агрегат для legacy `queueLen`). */
  totalQueued(): number {
    let n = 0;
    for (const slot of this.slots.values()) n += slot.queue.length;
    return n;
  }

  /**
   * Кладёт сообщение в очередь слота. Позиция (1-based) или null, если полна.
   * Вызывать только когда слот занят (свободный идёт сразу в ход).
   */
  enqueue(id: string | null, text: string, images: string[], sessionId: string | null): number | null {
    const slot = this.slotFor(id);
    if (slot.queue.length >= MAX_QUEUE_LENGTH) return null;
    slot.queue.push({ text, images, sessionId, ts: Date.now() });
    return slot.queue.length;
  }

  /**
   * Атомарно резервирует слот, возвращает токен владения.
   * Звать СИНХРОННО в том же тике, что пречек busy (см. handleMessagePost).
   */
  reserve(id: string | null): object {
    const slot = this.slotFor(id);
    const token = {};
    slot.token = token;
    slot.busy = true;
    return token;
  }

  /** Отпускает слот, только если `token` всё ещё владеет им. */
  release(id: string | null, token: object): boolean {
    const slot = this.slotFor(id);
    if (slot.token !== token) return false;
    slot.token = null;
    slot.busy = false;
    return true;
  }

  /** Безусловный сброс слота (форвардерный turn_end — владелец завершённого хода). */
  forceRelease(id: string | null): void {
    const slot = this.slotFor(id);
    slot.token = null;
    slot.busy = false;
  }

  /** Забирает голову очереди слота (undefined — пусто). */
  shift(id: string | null): QueuedMessage | undefined {
    return this.slotFor(id).queue.shift();
  }

  /** Длина очереди слота. */
  queueLen(id: string | null): number {
    return this.slotFor(id).queue.length;
  }

  /** Раннер сессии из кеша (undefined — ещё не спавнился). */
  getRunner(id: string): SessionRunner | undefined {
    return this.runners.get(id);
  }

  /** Раннер из кеша или свежий спавн (фабрика обязана — иначе throw). */
  getOrCreateRunner(id: string): SessionRunner {
    const cached = this.runners.get(id);
    if (cached) return cached;
    if (!this.factory) throw new Error("no runner factory");
    const runner = this.factory(id);
    this.runners.set(id, runner);
    return runner;
  }

  /** Id закешированных раннеров (для reconfigure). */
  runnerIds(): string[] {
    return [...this.runners.keys()];
  }

  /** Сброс слота сессии: раннер + очередь (сессия удалена, слот простаивает). */
  drop(id: string): void {
    this.disposeRunner(id);
    this.slots.delete(id);
  }

  /** Полный сброс (стоп сервера): раннеры, слоты, очереди. */
  clear(): void {
    for (const id of [...this.runners.keys()]) this.disposeRunner(id);
    this.slots.clear();
  }

  /** Отпустить раннер (вклад тулов плагинов снимается, реестр больше не нужен). */
  private disposeRunner(id: string): void {
    const runner = this.runners.get(id);
    this.runners.delete(id);
    try {
      runner?.dispose?.();
    } catch {
      /* раннер уже разобран — тихо */
    }
  }
}
