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
import { selectEvictions } from "./runner-gc";
import { SlotQueue } from "./run-queue";

/** Слот сессии: busy-резерв с токеном владения + FIFO входящих. */
export interface RunSlot {
  busy: boolean;
  token: object | null;
  queue: SlotQueue;
}

/** Фабрика раннеров из bootstrap (нет — legacy-режим без параллелизма). */
export type RunnerFactory = (sessionId: string) => SessionRunner;

/** Простой раннер без ходов (тесты). */
export const RUNNER_IDLE_MS = 10 * 60_000;

/** Сколько раннеров держим одновременно (LRU). */
export const RUNNER_LRU_MAX = 8;

/** Как часто чистим простаивающие раннеры. */
const SWEEP_INTERVAL_MS = 60_000;

/** Per-session пул: очереди, busy-слоты, кеш раннеров. Чистое состояние — IO в util. */
export class RunPool {
  private slots = new Map<string, RunSlot>();
  private runners = new Map<string, SessionRunner>();
  private factory?: RunnerFactory;
  private maxQueue: number;
  /** Монотонный id сообщений очереди (адресат cancel/start). */
  private nextQueuedId = 1;
  /** Последняя активность раннера (для LRU и idle-вытеснения). */
  private lastActive = new Map<string, number>();
  /** Таймер периодической чистки (null — не запущен). */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(factory?: RunnerFactory, maxQueue: number = MAX_QUEUE_LENGTH) {
    if (factory) this.factory = factory;
    this.maxQueue = maxQueue;
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
      slot = { busy: false, token: null, queue: new SlotQueue() };
      this.slots.set(key, slot);
    }
    return slot;
  }

  /**
   * Слот БЕЗ создания: читающие операции не должны плодить слоты
   * (аудит §6.11/§6.12).
   */
  private peekSlot(id: string | null): RunSlot | undefined {
    return this.slots.get(RunPool.key(id));
  }

  /** Занят ли слот (идёт ход). */
  isBusy(id: string | null): boolean {
    return this.peekSlot(id)?.busy ?? false;
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
    const slot = this.peekSlot(id);
    if (!slot) return;
    slot.token = null;
    slot.busy = false;
  }

  /**
   * Кладёт сообщение в очередь слота. Сообщение с id или null, если полна.
   * Вызывать только когда слот занят (свободный идёт сразу в ход).
   */
  enqueue(id: string | null, text: string, images: string[], sessionId: string | null): QueuedMessage | null {
    return this.slotFor(id).queue.enqueue(text, images, sessionId, this.maxQueue);
  }

  /** Упорядоченные id очереди сессии (для проекций состояния/клиента). */
  queuedIds(id: string | null): string[] {
    return this.slotFor(id).queue.ids();
  }

  /** Id очередей по сессиям (без legacy-слота, как `queuedCounts`). */
  queuedIdsBySession(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [key, slot] of this.slots) {
      if (key === "" || slot.queue.length === 0) continue;
      out[key] = slot.queue.ids();
    }
    return out;
  }

  /** Убирает сообщение очереди по id; undefined — такого уже нет. */
  removeQueued(id: string | null, messageId: string): QueuedMessage | undefined {
    return this.slotFor(id).queue.remove(messageId);
  }

  /** Переносит сообщение в голову очереди, сохраняя порядок остальных. */
  promoteQueued(id: string | null, messageId: string): QueuedMessage | undefined {
    return this.slotFor(id).queue.promote(messageId);
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
    const runner = this.runners.get(id);
    if (runner) this.lastActive.set(id, Date.now());
    return runner;
  }

  /** Раннер из кеша или свежий спавн (фабрика обязана — иначе throw). */
  getOrCreateRunner(id: string): SessionRunner {
    this.maybeSweep();
    const cached = this.runners.get(id);
    if (cached) {
      this.lastActive.set(id, Date.now());
      return cached;
    }
    if (!this.factory) throw new Error("no runner factory");
    const runner = this.factory(id);
    this.runners.set(id, runner);
    this.lastActive.set(id, Date.now());
    this.startSweeper();
    return runner;
  }

  /** Периодическая чистка простаивающих раннеров (не держит процесс живым). */
  private startSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /** Чистка, если с прошлой прошло достаточно времени. */
  private maybeSweep(): void {
    const now = Date.now();
    const last = this.lastSweepAt;
    if (last !== undefined && now - last < SWEEP_INTERVAL_MS) return;
    this.sweep(now);
  }

  private lastSweepAt?: number;

  /**
   * Вытесняет раннеры: простаивающие дольше `RUNNER_IDLE_MS` и лишние по LRU
   * (свыше `RUNNER_LRU_MAX`). Занятые и с очередью не трогаем (аудит §6.11).
   *
   * @returns число вытесненных раннеров.
   */
  sweep(now: number = Date.now()): number {
    this.lastSweepAt = now;
    const evict = selectEvictions(
      [...this.runners.keys()],
      this.lastActive,
      (id) => this.peekSlot(id)?.busy ?? false,
      now,
      RUNNER_IDLE_MS,
      RUNNER_LRU_MAX,
    );
    for (const id of evict) this.disposeRunner(id);
    return evict.length;
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
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const id of [...this.runners.keys()]) this.disposeRunner(id);
    this.slots.clear();
    this.lastActive.clear();
  }

  /** Отпустить раннер (вклад тулов плагинов снимается, реестр больше не нужен). */
  private disposeRunner(id: string): void {
    const runner = this.runners.get(id);
    this.runners.delete(id);
    this.lastActive.delete(id);
    try {
      runner?.dispose?.();
    } catch {
      /* раннер уже разобран — тихо */
    }
  }
}
