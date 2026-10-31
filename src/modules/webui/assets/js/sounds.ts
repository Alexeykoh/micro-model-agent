// Звуковые сигналы веб-UI (docs/specs/2026-10-31-webui-sounds-design.md).
//
// Правила («какой переход даёт какой сигнал») — чистые функции без DOM и
// WebAudio: их проверяет tests/webui-sounds.test.ts (INV-S1…S3). Воспроизведение
// — тонкая обёртка над WebAudio без аудиофайлов; браузер, не разрешивший
// автовоспроизведение, молча пропускает сигнал (INV-S4).
import { settings } from "./store.js";

/** Объект-словарь без `as`-каста: конфиг приходит из JSON. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Сигнал, который умеет играть веб-UI. */
export type SoundCue = "done" | "question" | "failed";

/** Разрешённые настройки звука (`ui.sounds.*`). */
export interface SoundPrefs {
  enabled: boolean;
  done: boolean;
  question: boolean;
  failed: boolean;
}

/** Дефолты совпадают с `DEFAULTS.ui.sounds` (см. src/config/defaults.ts). */
export const DEFAULT_SOUND_PREFS: SoundPrefs = {
  enabled: false,
  done: true,
  question: true,
  failed: true,
};

// Троттлинг: несколько вкладок завершаются одновременно — сигналы не должны
// складываться в «кашу». Любой сигнал частотой выше MIN_GAP_MS гасится, а
// повтор того же сигнала — ещё и в пределах SAME_CUE_GAP_MS.
export const MIN_GAP_MS = 150;
export const SAME_CUE_GAP_MS = 600;

/** Момент последнего сыгранного сигнала (для троттлинга). */
export interface SoundClock {
  at: number;
  cue: SoundCue | null;
}

/** Настройки из конфига. Отсутствующие или невалидные значения (старый конфиг,
 * мусор в JSON) трактуются как дефолты, а не как «выключено» (INV-S5).
 */
export function resolveSoundPrefs(sounds: unknown): SoundPrefs {
  const src = isRecord(sounds) ? sounds : {};
  const pick = (key: keyof SoundPrefs): boolean =>
    typeof src[key] === "boolean" ? (src[key] as boolean) : DEFAULT_SOUND_PREFS[key];
  return {
    enabled: pick("enabled"),
    done: pick("done"),
    question: pick("question"),
    failed: pick("failed"),
  };
}

/**
 * Сигнал для перехода статуса вкладки; `null` — молчать.
 *
 * Играем только на реальном переходе (INV-S2): повтор статуса, гидратация
 * вкладок и `dead` звука не дают. «Готово» — только из `working`, чтобы
 * открытие вкладки и `queued → idle` не звенели.
 */
export function cueForTransition(
  from: unknown,
  to: unknown,
  prefs: SoundPrefs,
): SoundCue | null {
  if (!prefs.enabled || from === to || typeof to !== "string") return null;
  if (to === "idle") return from === "working" && prefs.done ? "done" : null;
  if (to === "waiting") return prefs.question ? "question" : null;
  if (to === "failed") return prefs.failed ? "failed" : null;
  return null;
}

/** Можно ли играть сигнал сейчас (троттлинг и склейка повторов). */
export function shouldEmit(now: number, last: SoundClock | null, cue: SoundCue): boolean {
  if (!last) return true;
  const gap = now - last.at;
  if (!Number.isFinite(gap) || gap < 0) return true;
  if (gap < MIN_GAP_MS) return false;
  return !(last.cue === cue && gap < SAME_CUE_GAP_MS);
}

// [частота Гц, задержка с, длительность с] — контуры сигналов различимы на слух.
const TONES: Record<SoundCue, ReadonlyArray<readonly [number, number, number]>> = {
  done: [
    [660, 0, 0.09],
    [880, 0.1, 0.14],
  ],
  question: [
    [520, 0, 0.08],
    [520, 0.12, 0.08],
  ],
  failed: [
    [330, 0, 0.1],
    [240, 0.12, 0.16],
  ],
};

const CUE_GAIN = 0.05;

let audio: AudioContext | null = null;
let unlockArmed = false;

function audioContext(): AudioContext | null {
  if (audio) return audio;
  if (typeof window === "undefined") return null;
  if (typeof window.AudioContext !== "function") return null;
  try {
    audio = new window.AudioContext();
  } catch {
    return null;
  }
  return audio;
}

/**
 * Политика автовоспроизведения разрешает звук только после жеста. Слушатели
 * ставятся один раз и не мешают разметке (passive, без preventDefault).
 */
function armUnlock(): void {
  if (unlockArmed || typeof window === "undefined") return;
  unlockArmed = true;
  const resume = (): void => {
    const ac = audioContext();
    if (ac && ac.state !== "running") void ac.resume().catch(() => {});
  };
  window.addEventListener("pointerdown", resume, { passive: true });
  window.addEventListener("keydown", resume, { passive: true });
}

/** Играет сигнал; недоступный звук — тихий no-op (INV-S4). */
export function playCue(cue: SoundCue): void {
  armUnlock();
  const ac = audioContext();
  if (!ac) return;
  if (ac.state !== "running") {
    // Жест пользователя ещё не разблокировал контекст: пробуем и молчим.
    void ac.resume().catch(() => {});
    return;
  }
  const t0 = ac.currentTime + 0.01;
  for (const [freq, start, dur] of TONES[cue]) {
    const at = t0 + start;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    // Плавная огибающая: без неё на краях слышны щелчки.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(CUE_GAIN, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }
}

let lastCue: SoundClock | null = null;

/**
 * Единственная точка входа для вкладок: переводит переход статуса в сигнал,
 * читает актуальные настройки из конфига и применяет троттлинг.
 * Возвращает сыгранный сигнал (для тестов/диагностики) или `null`.
 */
export function notifyTabStatus(from: unknown, to: unknown): SoundCue | null {
  const ui = settings.config && settings.config.ui;
  const prefs = resolveSoundPrefs(isRecord(ui) ? ui.sounds : undefined);
  const cue = cueForTransition(from, to, prefs);
  if (!cue) return null;
  const now = Date.now();
  if (!shouldEmit(now, lastCue, cue)) return null;
  lastCue = { at: now, cue };
  playCue(cue);
  return cue;
}
