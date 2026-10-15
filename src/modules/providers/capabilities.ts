// Возможности модели (vision/tools/reasoning) : резолв пресет → probe → оверрайд.
import type { ModelCapabilities } from "../../config/types";

/**
 * Консервативный фолбэк, когда ни пресет, ни probe, ни конфиг не дали данных.
 * "false" безопаснее "true": неверное "нет vision" ведёт к текстовому
 * snapshot'у, неверное "есть vision" — к отправке картинки, которую бэкенд
 * отвергнет или проигнорирует.
 */
export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
  vision: false,
  tools: false,
};

/** Минимальная форма возможностей пресета, достаточная для резолва. */
export interface PresetCapabilities {
  vision: boolean;
  tools: boolean;
  /** Механизм reasoning, заявленный пресетом провайдера (нижний слой). */
  reasoningStrategy?: import("../../config/types").ReasoningStrategy;
}

/**
 * Единый источник правды о возможностях АКТИВНОЙ модели (данные, не
 * эвристика по имени — правило #10). Приоритет слоёв, от высшего к низшему:
 *
 *   1. явный конфиг-оверрайд пользователя (`config.modelCapabilities[model]`);
 *   2. живой probe провайдера (LM Studio native API и т.п.);
 *   3. пресет провайдера (`providers/presets.ts`).
 *
 * Всегда возвращает новый объект: вызывающий не рискует мутировать общий
 * пресет или конфиг. Отсутствующие в probe поля берутся из нижнего слоя —
 * probe может уточнять только часть возможностей.
 */
export function resolveModelCapabilities(
  preset: PresetCapabilities | undefined,
  probe: ModelCapabilities | undefined,
  override: ModelCapabilities | undefined,
): ModelCapabilities {
  const base: ModelCapabilities = preset
    ? { vision: preset.vision, tools: preset.tools, reasoningStrategy: preset.reasoningStrategy }
    : { ...DEFAULT_MODEL_CAPABILITIES };
  return { ...base, ...(probe ?? {}), ...(override ?? {}) };
}
