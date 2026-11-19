/**
 * Калибровка оценки контекста по реальному `usage` провайдера.
 *
 * Первопричина каскада ложных компакций (сессия ses_muu8kfbw_nyxkre):
 * `cl100k`-оценка кириллицы/кода/картинок систематически завышает фактические
 * токены Qwen (до 4.85×), а пороги компакции считались по сырой оценке. Здесь
 * сырая оценка (`raw`) уточняется по последнему достоверному `prompt_tokens`:
 * baseline + дельта, с защитой от «провайдер молча усекает промпт».
 *
 * Контракт безопасности: калибровка **только снижает** завышение (итог всегда
 * ≤ raw) и **никогда не опускает** значение ниже floor (guard от обрезки), в
 * фазе прогрева и при stale — возвращается raw как есть.
 */

/** Состояние калибровочной модели. */
export type CalibrationState = "cold" | "warming" | "trusted" | "stale";

/** Один сэмпл: реальный и оценочный объём промпта на момент вызова. */
export interface CalibrationSample {
  actual: number;
  estimated: number;
  messageCount: number;
}

/** Опции калибратора (все с безопасными дефолтами). */
export interface ContextCalibratorOptions {
  /** Число вызовов прогрева: cold/warming — пороги считаются по raw. */
  warmup?: number;
  /** Нижняя граница калибровки как доля raw (guard от обрезки провайдером). */
  ratioFloor?: number;
  /** Абсолютный «запас» от края: floor = max(raw*ratioFloor, raw-absoluteSlack). */
  absoluteSlack?: number;
  /** EMA-сглаживание fallback-ratio в warming. */
  emaAlpha?: number;
  /** Минимум сэмплов для перехода в trusted. */
  minSamples?: number;
}

const DEFAULTS = {
  warmup: 3,
  ratioFloor: 0.5,
  // «Запас» от края: калибровка может снизить оценку не более чем на этот
  // абсолютный объём (или до 50% raw — что консервативнее). Достаточно велик,
  // чтобы уточнять нормальное 0.9×-завышение, но не даёт принять усечённый
  // провайдером промпт за реально дешёвый контекст.
  absoluteSlack: 20000,
  emaAlpha: 0.3,
  minSamples: 2,
} as const;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Калибратор оценки контекста: baseline+delta (primary) и EMA-ratio (fallback).
 * Per-session, in-memory. Потокобезопасность не требуется — живёт внутри
 * per-session `ContextManager`.
 */
export class ContextCalibrator {
  private readonly warmup: number;
  private readonly ratioFloor: number;
  private readonly absoluteSlack: number;
  private readonly emaAlpha: number;
  private readonly minSamples: number;

  /** Последний достоверный (`actual`, соответствующий `estimated`) baseline. */
  private baseline: { actual: number; estimated: number } | null = null;
  /** EMA отношения actual/estimated за прогрев. */
  private emaRatio: number | null = null;
  private samples = 0;
  /** Вызовов LLM с момента последнего `observe` без usage. */
  private callsSinceUsage = 0;
  private state: CalibrationState = "cold";

  constructor(opts: ContextCalibratorOptions = {}) {
    this.warmup = opts.warmup ?? DEFAULTS.warmup;
    this.ratioFloor = opts.ratioFloor ?? DEFAULTS.ratioFloor;
    this.absoluteSlack = opts.absoluteSlack ?? DEFAULTS.absoluteSlack;
    this.emaAlpha = opts.emaAlpha ?? DEFAULTS.emaAlpha;
    this.minSamples = opts.minSamples ?? DEFAULTS.minSamples;
  }

  /**
   * Принимает реальный `usage` после LLM-вызова.
   * @param actual реальные `prompt_tokens` провайдера.
   * @param estimatedAtSend сырая оценка контекста на момент отправки запроса.
   * @param messageCount число сообщений на момент отправки.
   */
  observe(actual: number, estimatedAtSend: number, messageCount: number): void {
    this.callsSinceUsage = 0;
    if (!Number.isFinite(actual) || actual <= 0 || !Number.isFinite(estimatedAtSend)) {
      // Мусорный/нулевой usage не должен отравлять модель — считаем неизвестным.
      this.state = "stale";
      return;
    }
    this.baseline = { actual, estimated: estimatedAtSend };
    const ratio = estimatedAtSend > 0 ? actual / estimatedAtSend : 1;
    this.emaRatio = this.emaRatio === null
      ? ratio
      : this.emaAlpha * ratio + (1 - this.emaAlpha) * this.emaRatio;
    this.samples++;
    if (this.samples < this.warmup) {
      this.state = "warming";
    } else {
      this.state = "trusted";
    }
    void messageCount;
  }

  /** Инвалидация baseline: компакция, reconfigure, смена system-промпта. */
  invalidate(): void {
    this.baseline = null;
    this.state = "stale";
  }

  /**
   * Помечает, что LLM-вызов прошёл без `usage` (провайдер не отдал токены).
   * Более одного вызова без usage → stale (фолбэк на raw).
   */
  noteMissingUsage(): void {
    this.callsSinceUsage++;
    if (this.callsSinceUsage > 1) this.state = "stale";
  }

  /** Текущее состояние калибровки. */
  getState(): CalibrationState {
    return this.state;
  }

  /** Текущее эффективное отношение (EMA или ratio baseline), 1 если неизвестно. */
  getRatio(): number {
    if (this.state === "trusted" && this.baseline && this.baseline.estimated > 0) {
      return this.baseline.actual / this.baseline.estimated;
    }
    return this.emaRatio ?? 1;
  }

  /**
   * Калиброванная оценка объёма контекста.
   *
   * В `cold`/`warming`/`stale` возвращается `raw` (пороги консервативны). В
   * `trusted` — `baseline.actual + (raw − baseline.estimated)`, зажатая в
   * `[max(raw*ratioFloor, raw−absoluteSlack), raw]`.
   *
   * @param raw сырая оценка (сообщения + тулы).
   * @param messageCount текущее число сообщений (для совместимости/диагностики).
   */
  calibrate(raw: number, messageCount: number): number {
    void messageCount;
    if (raw <= 0) return raw;
    if (this.state !== "trusted" || !this.baseline) return raw;

    const delta = raw - this.baseline.estimated;
    let cal = this.baseline.actual + delta;

    // Floor: не учимся считать раздутый контекст дешёвым, если провайдер
    // молча усекает промпт и возвращает маленький `actual`.
    const floor = Math.max(raw * this.ratioFloor, raw - this.absoluteSlack);
    if (cal < floor) cal = floor;

    // Итог всегда в [ratioFloor*raw, raw] — калибровка только снижает завышение.
    return Math.round(clamp(cal, raw * this.ratioFloor, raw));
  }
}

/** Константы safety-clamp (guard от необъяснимого скачка оценки). */
export const IMPLAUSIBLE_JUMP = 3;
export const MAX_PLAUSIBLE_DELTA = 20000;

/**
 * True, если оценка выросла неправдоподобно относительно предыдущей без
 * соответствующего роста числа сообщений — по такому сигналу компакцию
 * запускать нельзя (защита даже от не найденной причины скачка).
 *
 * @param raw текущая сырая оценка.
 * @param prevRaw предыдущая сырая оценка (0 — неизвестна).
 * @param messageCount текущее число сообщений.
 * @param prevMessageCount число сообщений на момент prevRaw.
 */
export function isImplausibleJump(
  raw: number,
  prevRaw: number,
  messageCount: number,
  prevMessageCount: number,
): boolean {
  if (prevRaw <= 0) return false;
  if (raw <= prevRaw * IMPLAUSIBLE_JUMP) return false;
  if (raw - prevRaw <= MAX_PLAUSIBLE_DELTA) return false;
  // Рост числа сообщений хотя бы на 20% объясняет скачок (большие tool-результаты).
  if (prevMessageCount <= 0) return raw - prevRaw > MAX_PLAUSIBLE_DELTA;
  if (messageCount >= prevMessageCount * 1.2) return false;
  return true;
}
