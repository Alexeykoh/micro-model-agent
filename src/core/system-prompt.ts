/**
 * Системный промпт агента: баррель публичного пути `./system-prompt`.
 *
 * Части вынесены по правилу ≤300 строк: рендер (`system-prompt-render`),
 * service-job (`system-prompt-service`), живая пересборка статики
 * (`system-prompt-refresh`). Баррель ничего из них не импортирует — только
 * реэкспортирует, поэтому цикла `system-prompt ⟲ system-prompt-refresh` нет.
 *
 * Поведенческие фразы под тестами (tests/core/bootstrap.test.ts) хранятся
 * дословно: "DONE CONDITIONS", "STOP AND ASK THE USER", "ANSWER IN CHAT",
 * "MEMORY PRIVACY", "SECURITY RESTRICTIONS".
 */
import type { PromptBlock } from "./types";
import { estimateTokens } from "../llm/token-counter";

export { buildSystemInfo, LARGE_WINDOW_THRESHOLD, resolvePromptProfile } from "./system-prompt-render";
export { buildServiceJobPrompt } from "./system-prompt-service";
export { applyClientTz, refreshSystemInfoBlock } from "./system-prompt-refresh";

/**
 * Динамический блок идентичности активной модели. Собирается свежим на
 * каждом билде системного промпта, поэтому переживает `/model use`/
 * `/provider use`: статичный заголовок `buildSystemInfo` фиксируется на
 * bootstrap, и после смены модели промпт продолжал называть прежнюю
 * (наблюдалось: заголовок говорил `qwen3.8-9b-distill`, а ход шёл на
 * `mellum2.1-12b-a2.5b-thinking` — сессия `ses_mv44qabg_s1przq`).
 * Идентичность модели убрана из статичного заголовка и отдаётся этому блоку —
 * иначе два источника расходятся.
 * @param model активная модель из живого конфига.
 */
export function buildModelBlock(model: string): PromptBlock {
  const content = `ACTIVE MODEL: ${model} — this is the model you are running on right now.`;
  return {
    source: "core",
    label: "model",
    content,
    // B13: normal, а не low — идентичность вылетала первой при давлении
    // бюджета, хотя путаница моделей стоит дороже всего блока (~20 ток).
    // Не essential: B3-гейт честно предупредит, если не влезет даже она.
    priority: "normal",
    essential: false,
    estimatedTokens: estimateTokens(content),
  };
}
