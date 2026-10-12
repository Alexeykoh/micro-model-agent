// Детерминированные проверки заявлений финального ответа (без LLM) — вынесено
// из `hallucination-gate.ts` (правило ≤300). Каждый класс — свой bounded-бюджет
// перепроверок (fail-open), чтобы съеденный бюджет одной проверки не экранировал
// другую ложь в том же ответе.
import { t } from "../../i18n/index";
import {
  checkSuccessClaim as detectSuccessClaim,
  type ClaimContradiction,
} from "../../core/hallucination/success-claim";
import { checkArtifactClaims, checkUnverifiedOutput } from "../../core/hallucination/artifact-claim";
import { checkWebClaims } from "../../core/hallucination/web-claims";
import { checkClaimedFileCreation } from "../../core/hallucination/file-creation-claim";
import { MAX_CLAIM_CHECK_RETRIES } from "./constants";
import type { HallucinationGateDeps, HallucinationVerdict } from "./hallucination-gate";

/**
 * Свежие выводы тулов для проверки заявлений: последние 10 сообщений
 * role:"tool" (текст урезан; чекер режет повторно).
 */
export function lastToolEvidence(
  deps: HallucinationGateDeps,
): Array<{ name?: string; ok?: boolean; text: string }> {
  let history: Array<{ role: string; name?: string; content?: unknown; success?: boolean }>;
  try {
    history = deps.contextManager.getActiveHistory() ?? [];
  } catch {
    return [];
  }
  return history
    .filter((m) => m.role === "tool")
    .slice(-10)
    .map((m) => ({
      name: m.name,
      ok: m.success,
      text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) ?? "",
    }))
    .filter((m) => m.text.trim().length > 0);
}

/**
 * Отклонённый черновик уже отстримлен в ленту: уведомляем потребителей
 * (`retract`), чтобы убрать его до переответа. Плюс пишем `claim_retry` в сессию.
 */
export function retractDraft(deps: HallucinationGateDeps, kind: string, reason: string): void {
  deps.onMeta?.(t("ui.draft_retracted"), "retract");
  deps.slog?.logClaimRetry({ kind, reason, iteration: deps.state.iteration });
}

/**
 * Общий инжект claim-повтора: фиксирует отклонённый ответ, дописывает причину
 * как `<system-summary>` и просит цикл о следующем ходе.
 */
function retryClaim(
  deps: HallucinationGateDeps,
  textContent: string | undefined,
  reason: string,
  logLine: string,
  kind: string,
): HallucinationVerdict {
  const { state, logger } = deps;
  state.iterHallucinationRetry = true;
  // Переответ пересказывает выполненную задачу и естественно повторяется —
  // бюджет халлюцинаций на его форму не жжём.
  state.suppressRepetitionRetry = true;
  logger.diagnostic("warn", logLine);
  retractDraft(deps, kind, reason);
  if (textContent) {
    deps.contextManager.addMessage({ role: "assistant", content: textContent });
  }
  deps.contextManager.addMessage({
    role: "user",
    content: `<system-summary>${reason} Original task: "${deps.input}".</system-summary>`,
  });
  return { action: "retry" };
}

/**
 * Детерминированные проверки заявлений против улик (без LLM): success-claim
 * плюс заземление артефактов и провенанс вывода. Возвращает первый вердикт
 * retry или null.
 */
export function checkClaims(
  deps: HallucinationGateDeps,
  textContent: string | undefined,
): HallucinationVerdict | null {
  const { state } = deps;
  const text = textContent ?? "";
  const evidence = lastToolEvidence(deps);
  const classes: Array<{
    remaining: number;
    bump: () => void;
    detect: () => (ClaimContradiction & { path?: string }) | null;
    reason: (c: ClaimContradiction & { path?: string }) => string;
    log: string;
    kind: string;
  }> = [
    {
      remaining: MAX_CLAIM_CHECK_RETRIES - state.claimCheckRetries,
      bump: () => state.claimCheckRetries++,
      detect: () => detectSuccessClaim(text, evidence),
      reason: (c) => t("hall.claim_contradiction", { tool: c.tool, snippet: c.snippet }),
      log: "Success-claim contradiction",
      kind: "success",
    },
    {
      remaining: deps.artifacts?.length
        ? MAX_CLAIM_CHECK_RETRIES - state.artifactClaimRetries
        : 0,
      bump: () => state.artifactClaimRetries++,
      detect: () => checkArtifactClaims(text, deps.artifacts ?? []),
      reason: (c) => t("hall.claim_artifact", { path: c.path ?? "", detail: c.snippet }),
      log: "Artifact-claim contradiction",
      kind: "artifact",
    },
    {
      remaining: MAX_CLAIM_CHECK_RETRIES - state.outputClaimRetries,
      bump: () => state.outputClaimRetries++,
      detect: () => checkUnverifiedOutput(text, evidence),
      reason: (c) => t("hall.claim_output_unverified", { detail: c.snippet }),
      log: "Unverified output",
      kind: "output",
    },
    {
      remaining: MAX_CLAIM_CHECK_RETRIES - state.webClaimRetries,
      bump: () => state.webClaimRetries++,
      detect: () => checkWebClaims(text, evidence),
      reason: (c) => t("hall.claim_web_unverified", { detail: c.snippet }),
      log: "Unverified web figures",
      kind: "web",
    },
    {
      remaining: MAX_CLAIM_CHECK_RETRIES - state.fileCreationRetries,
      bump: () => state.fileCreationRetries++,
      detect: () => checkClaimedFileCreation(text, evidence, deps.input),
      reason: (c) => t("hall.claim_file_not_created", { detail: c.snippet }),
      log: "Claimed file creation without a write",
      kind: "file",
    },
  ];
  for (const cls of classes) {
    if (cls.remaining <= 0) continue;
    const contradiction = cls.detect();
    if (!contradiction) continue;
    cls.bump();
    return retryClaim(
      deps,
      textContent,
      cls.reason(contradiction),
      `${cls.log}: ${contradiction.snippet}`,
      cls.kind,
    );
  }
  return null;
}
