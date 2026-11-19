/**
 * Единая точка подписки webui на процессные шины: терминальный лог,
 * снимок исходящего запроса (U20) и журнал защиты (U22).
 *
 * Вынесено отдельным модулем, чтобы `module.ts` (на потолке ≤300) не набирал
 * по строке на каждый мост, а отписка была одна и симметричная установке.
 */
import type { SseTransport } from "./state";
import type { RunPool } from "../../runtime/run-pool/run-pool";
import { installOutputForwarding } from "./log-forward";
import { installRequestForwarding } from "./session/request-forward";
import { installSecurityForwarding } from "./session/security-forward";

/** Узкая роль вместо собранного `WebUiState` (гейт границ W4). */
export type ForwardState = SseTransport & { pool?: RunPool };

/** Подписать `mma web` на все глобальные шины; возвращает общую отписку. */
export function installWebForwarding(state: ForwardState): () => void {
  const offs = [
    installOutputForwarding(state),
    installRequestForwarding(state),
    installSecurityForwarding(state),
  ];
  return () => {
    for (const off of offs) off();
  };
}
