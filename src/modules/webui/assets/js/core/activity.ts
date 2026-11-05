// Единая правда о фазе хода: что агент делает сейчас и сколько времени идёт.
//
// Раньше фаза и время жили в двух независимых местах: строка «думаю» в ленте
// (свой таймер от момента показа) и рельс над композером (свой таймер от
// флага busy). На длинном ходе они расходились — лента писала «думаю», рельс
// «пишу», а секунды считались от разных стартов. Здесь состояние одно на
// сессию, и обе поверхности читают его.
import { t } from "../i18n.js";

/** Что агент делает прямо сейчас. */
export type ActivityPhase = "thinking" | "composing" | "tool";

/** Событие хода, меняющее фазу. */
export type ActivityEvent = "thinking" | "text" | "reasoning" | "tool_start" | "tool_end" | "done";

export interface Activity {
  phase: ActivityPhase;
  /** Момент старта хода (epoch ms). 0 — ход не идёт. */
  startedAt: number;
  /** Момент конца хода (epoch ms). 0 — ход ещё идёт. */
  endedAt: number;
  busy: boolean;
}

const states = new Map<string, Activity>();
const listeners = new Map<string, Set<() => void>>();
const globalListeners = new Set<() => void>();
let currentKey = "";

function blank(): Activity {
  return { phase: "thinking", startedAt: 0, endedAt: 0, busy: false };
}

/** Состояние сессии (создаётся при первом обращении). */
export function activityFor(key: string): Activity {
  let s = states.get(key);
  if (!s) {
    s = blank();
    states.set(key, s);
  }
  return s;
}

/** Состояние сессии без создания — чтобы выбрать, чью фазу показывать. */
export function activityLookup(key: string): Activity | undefined {
  return states.get(key);
}

function notify(key: string): void {
  const set = listeners.get(key);
  if (set) for (const cb of set) cb();
  for (const cb of globalListeners) cb();
}

/** Ход начался: запускаем часы (повторный вызов их не перезапускает). */
export function activityStart(key: string, now = Date.now()): void {
  const s = activityFor(key);
  if (!s.busy) {
    s.busy = true;
    s.startedAt = now;
    s.endedAt = 0;
    s.phase = "thinking";
  }
  currentKey = key;
  notify(key);
}

/** Ход закончился: часы замерли на финальном значении, фаза сброшена. */
export function activityStop(key: string, now = Date.now()): void {
  const s = activityFor(key);
  s.busy = false;
  if (s.startedAt) s.endedAt = now;
  s.phase = "thinking";
  if (currentKey === key) currentKey = "";
  notify(key);
}

/**
 * Событие хода. Фаза — по факту события, а не по таймеру: модель пишет
 * (`text`), думает (`thinking`/`reasoning`), тул работает (`tool_start`).
 */
export function activityNote(key: string, kind: ActivityEvent, now = Date.now()): void {
  const s = activityFor(key);
  if (!s.busy) {
    s.busy = true;
    s.startedAt = now;
    s.endedAt = 0;
  }
  if (kind === "text") s.phase = "composing";
  else if (kind === "tool_start") s.phase = "tool";
  else s.phase = "thinking";
  currentKey = key;
  notify(key);
}

/** Фаза сессии. */
export function activityPhase(key: string): ActivityPhase {
  return activityFor(key).phase;
}

/** Сколько секунд идёт (или длился) ход. */
export function activitySeconds(key: string, now = Date.now()): number {
  const s = activityFor(key);
  if (!s.startedAt) return 0;
  const end = s.endedAt || now;
  return Math.max(0, (end - s.startedAt) / 1000);
}

/** Время хода в одном формате — одинаково на ленте и на рельсе. */
export function activityTimeText(key: string, now = Date.now()): string {
  return activitySeconds(key, now).toFixed(1) + "s";
}

/** Подпись фазы — одна на все поверхности (лента и рельс). */
export function activityLabel(key: string): string {
  const phase = activityPhase(key);
  if (phase === "tool") return t("web.rail.working");
  if (phase === "composing") return t("web.rail.composing");
  return t("web.action.thinking");
}

/** Сессия с последней активностью — её фазу показывает глобальный рельс. */
export function activityCurrentKey(): string {
  return currentKey;
}

/** Подписка на смену фазы/времени хода; возвращает отписку. */
export function activitySubscribe(key: string, cb: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(cb);
  return () => {
    const cur = listeners.get(key);
    if (!cur) return;
    cur.delete(cb);
    if (!cur.size) listeners.delete(key);
  };
}

/**
 * Подписка на любое изменение хода — для рельса: он один на окно и смотрит
 * на «текущую» сессию, которая может смениться.
 */
export function activitySubscribeAll(cb: () => void): () => void {
  globalListeners.add(cb);
  return () => {
    globalListeners.delete(cb);
  };
}
