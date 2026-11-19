/**
 * Снимок провайдера для поверхностей (CLI/REPL/web): какой reasoning реально
 * применён и какие возможности разрешились у активной пары preset → probe →
 * override. Вынесено из `agent-base.ts` (правило 6: ≤300 строк).
 */
import type { ReasoningStrategy } from "../../config/types";
import type { ModelCapabilities } from "../../config/types";
import { reasoningCapsForProvider } from "../../modules/providers/reasoning-resolve";
import type { AgentDeps } from "./deps";

/** Всё, что нужно для резолва: активный конфиг и живая probe возможностей. */
export type ProviderSnapshotDeps = Pick<AgentDeps, "config" | "capabilitiesProbeRef">;

/** Итог снимка: механизм reasoning + разрешённые возможности модели. */
export interface ProviderReasoningSnapshot {
  strategy?: ReasoningStrategy;
  levels?: string[] | null;
  reasoningOff?: boolean;
  reachable?: boolean;
  /** Холодная модель не отдала /props — поверхность может повторить пробу. */
  needsReprobe?: boolean;
  /** Разрешённые возможности активной пары (preset → probe → override). */
  vision?: boolean;
  video?: boolean;
  audio?: boolean;
  pdf?: boolean;
  tools?: boolean;
}

/** Живой снимок провайдера; ничего не кеширует — читает deps в момент вызова. */
export function providerReasoningSnapshot(deps: ProviderSnapshotDeps): ProviderReasoningSnapshot {
  const ref = deps.capabilitiesProbeRef;
  const caps: ModelCapabilities = reasoningCapsForProvider(
    deps.config.provider,
    ref?.probe,
    deps.config.modelCapabilities?.[deps.config.model],
  );
  return {
    strategy: ref?.reasoningStrategy,
    levels: ref?.reasoningLevels ?? null,
    needsReprobe: ref?.needsReasoningReprobe === true,
    reasoningOff: ref?.reasoningOff,
    reachable: ref?.reachable,
    vision: caps.vision,
    video: caps.video,
    audio: caps.audio,
    pdf: caps.pdf,
    tools: caps.tools,
  };
}
