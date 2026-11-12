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
import type { ClientTz } from "../../../core/prompt-facts";
import type { QueuedMessage } from "../state";
import { MAX_QUEUE_LENGTH } from "../limits";
import {
  startSweeper,
  stopSweeper,
  sweepIfDue,
  sweepRunners,
  type SweepState,
} from "./pool-sweep";

export { RUNNER_IDLE_MS, RUNNER_LRU_MAX } from "./pool-sweep";
import { SlotQueue } from "./run-queue";
import {
  anyBusyOf,
  busyIdsOf,
  queuedCountsOf,
  queuedIdsBySessionOf,
  totalQueuedOf,
} from "./pool-aggregates";

/** Слот сессии: busy-резерв с токеном владения + FIFO входящих. */
export interface RunSlot {
  busy: boolean;
  token: object | null;
  queue: SlotQueue;
}

/** Фабрика раннеров из bootstrap (нет — legacy-режим без параллелизма). */
export type RunnerFactory = (sessionId: string) => SessionRunner;

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
  /** Последний присланный часовой пояс клиента по сессии (B18b). */
  private clientTz = new Map<string, ClientTz>();
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

  /** Id занятых сессионных слотов (для бейджей вкладок). */
  busyIds(): string[] {
    return busyIdsOf(this.slots);
  }

  /** Занят ли хоть один слот (агрегат для legacy `s.busy`). */
  anyBusy(): boolean {
    return anyBusyOf(this.slots);
  }

  /** Счётчики очереди по сессиям (для бейджей). */
  queuedCounts(): Record<string, number> {
    return queuedCountsOf(this.slots);
  }

  /** Длина всех очередей (агрегат для legacy `queueLen`). */
  totalQueued(): number {
    return totalQueuedOf(this.slots);
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
    return queuedIdsBySessionOf(this.slots);
  }

  /** Убирает сообщение очереди по id; undefined — такого уже нет. */
  removeQueued(id: string | null, messageId: string): QueuedMessage | undefined {
    return this.slotFor(id).queue.remove(messageId);
  }

  /** Переносит сообщение в голову очереди, сохраняя порядок остальных. */
  promoteQueued(id: string | null, messageId: string): QueuedMessage | undefined {
    return this.slotFor(id).queue.promote(messageId);
  }

  editQueued(id: string | null, messageId: string, text: string): QueuedMessage | undefined {
    return this.slotFor(id).queue.edit(messageId, text);
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

  /**
   * Запоминает часовой пояс клиента сессии (B18b): фронт шлёт с каждым POST,
   * берём последний (смена пояса посреди сессии — редкость, latest wins).
   */
  setClientTz(id: string, tz: ClientTz | undefined): void {
    if (tz) this.clientTz.set(id, tz);
    else this.clientTz.delete(id);
  }

  /** Последний часовой пояс клиента сессии (undefined — не присылал). */
  getClientTz(id: string): ClientTz | undefined {
    return this.clientTz.get(id);
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
  private sweeperState(): SweepState {
    return {
      runners: this.runners,
      lastActive: this.lastActive,
      isBusy: (id) => this.peekSlot(id)?.busy ?? false,
      disposeRunner: (id) => this.disposeRunner(id),
      lastSweepAt: this.lastSweepAt,
      timer: this.sweepTimer,
    };
  }

  private startSweeper(): void {
    startSweeper(this.sweeperState(), () => this.sweep());
  }

  private maybeSweep(): void {
    sweepIfDue(this.sweeperState(), (now) => this.sweep(now));
  }

  private lastSweepAt?: number;

  /** Вытеснение idle/LRU-раннеров (детали — в pool-sweep.ts). */
  sweep(now: number = Date.now()): number {
    const count = sweepRunners(this.sweeperState(), now);
    this.lastSweepAt = now;
    return count;
  }


  /** Id закешированных раннеров (для reconfigure). */
  runnerIds(): string[] {
    return [...this.runners.keys()];
  }

  /** Сброс слота сессии: раннер + очередь (сессия удалена, слот простаивает). */
  drop(id: string): void {
    this.disposeRunner(id);
    this.slots.delete(id);
    this.clientTz.delete(id);
  }

  /** Полный сброс (стоп сервера): раннеры, слоты, очереди. */
  clear(): void {
    stopSweeper(this.sweeperState());
    for (const id of [...this.runners.keys()]) this.disposeRunner(id);
    this.slots.clear();
    this.lastActive.clear();
    this.clientTz.clear();
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
