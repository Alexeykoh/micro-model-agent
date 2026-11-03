// Встроенные сценарии сертификации по тегам (core/security/image/сеть/браузер/shell/research).
// Сама таблица разбита по группам в `scenarios-*.ts` (правило ≤300); здесь —
// базовый конфиг провайдера и сборка в исходном порядке.
import type { CertScenario } from "./types";
import type { ScenarioDef } from "./scenarios-def";
import { FILE_SCENARIOS } from "./scenarios-files";
import { WORKFLOW_SCENARIOS } from "./scenarios-workflows";
import { EXTERNAL_SCENARIOS } from "./scenarios-external";
import { SECURITY_SCENARIOS } from "./scenarios-security";
import { SHELL_SCENARIOS } from "./scenarios-shell";

/** Рассуждающие локальные модели (qwen3.5-9b в LM Studio) обрезают аргументы
 *  tool_call на дефолтном лимите 4096 токенов комплишена — прогон затем тонет
 *  в recoverable-ретраях, не закончив задачу. Не хватает и 12288: модель порой
 *  жжёт 12K+ на один reasoning посреди tool_call (прогон 2026-08-25, сценарий
 *  3.5, повторы 2/3). Поднимаем лимит всем сценариям, чтобы мерилось выполнение
 *  задачи, а не везение токенизатора (docs/small-model-observations.md, 2026-08-25). */
const PROVIDER_BASE = {
  provider: { maxCompletionTokens: 16384 },
  reasoning: { mode: "none", min: "low", max: "high", overrideCooldown: 3 },
};

const SCENARIO_DEFS: ScenarioDef[] = [
  ...FILE_SCENARIOS,
  ...WORKFLOW_SCENARIOS,
  ...EXTERNAL_SCENARIOS,
  ...SECURITY_SCENARIOS,
  ...SHELL_SCENARIOS,
];

/** Встроенные сценарии с подмешанным базовым конфигом провайдера. */
export const BUILTIN_SCENARIOS: CertScenario[] = SCENARIO_DEFS.map((s) => ({
  ...s,
  config: { ...PROVIDER_BASE, ...(s.config ?? {}) },
}));
