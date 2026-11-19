// `capabilities` для чипа композера: одна форма для `GET /api/models` и для
// ответа на свитч пары. Вынесено из `settings/config-api.ts` (правило 6).
import type { ModelCapabilities } from "../../../config/types";

/** Тело `capabilities` для чипа: только булевы флаги, `false` вместо undefined. */
export function capabilitiesBody(
  probe: ModelCapabilities | undefined,
): Record<string, boolean> | undefined {
  if (!probe) return undefined;
  return {
    vision: probe.vision === true,
    video: probe.video === true,
    audio: probe.audio === true,
    pdf: probe.pdf === true,
    tools: probe.tools === true,
  };
}
