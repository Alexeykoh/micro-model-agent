/**
 * «Нет новых улик после critical» (живая сессия `ses_mvzp8cuk_ntwlmbthlcifwp`):
 * модель переписала описание плана, не вызвав ни одного тула. Повторная
 * проверка того же evidence даёт тот же вердикт за полную цену, поэтому один
 * раз выдаётся директива «действуй», а затем ответ принимается честно
 * (`critic_verdict { accepted, exhausted }`).
 *
 * Вынесено из `critic-gate.ts` (правило ≤300).
 */
import { t } from "../../i18n/index";
import type { CriticVerdict } from "../../modules/critic/types";
import type { CriticGateDeps } from "./critic-contract";
import { announceRetract, criticRetractInfo } from "./draft-retract";

/**
 * Улики не изменились после `critical`: тот же набор тул-событий, другой текст.
 * Для `concern` не действует (переписанный ответ — законный ответ на совет), и
 * для хода без тулов (чат-доставка: текст и есть единственная улика, INV-C7).
 */
export function stalledAfterVerdict(
  lastVerdict: CriticVerdict | undefined,
  lastEvidenceKey: string | undefined,
  evidenceKey: string,
  toolEventCount: number,
): boolean {
  return lastVerdict?.status === "critical" && lastEvidenceKey === evidenceKey && toolEventCount > 0;
}

/** Понудительная директива + отзыв черновика (в ленте не должно быть двух планов). */
export function injectActDirective(
  deps: CriticGateDeps,
  verdict: CriticVerdict,
  cycle: number,
): void {
  announceRetract(deps.onMeta, criticRetractInfo(verdict, [], deps.iteration), deps.slog);
  deps.slog.logCritic("critic_escalation", {
    summary: verdict.summary,
    cycle,
    reason: "no_new_evidence",
  });
  deps.contextManager.addMessage({
    role: "user",
    content: `<system-summary>${t("critic.act", { summary: verdict.summary })}</system-summary>`,
  });
}
