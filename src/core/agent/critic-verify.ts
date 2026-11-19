/**
 * Один вызов критика под бюджетом и внешней отменой: прогресс по проходам,
 * отказ/таймаут/ручная остановка. Вынесено из `critic-gate.ts` (правило ≤300).
 */
import { t } from "../../i18n/index";
import type { CriticStage, CriticVerdict, EvidencePack } from "../../modules/critic/types";
import { CRITIC_SLOW_NOTICE_MS } from "../../config/timeouts";
import { noticeAfter } from "./slow-notice";
import { runWithBudget } from "./critic-budget";
import { criticStageLine } from "./critic-report";
import type { CriticGateDeps } from "./critic-contract";

/** Итог одной проверки: вердикт (или null), причина отказа, признак таймаута, мс. */
export interface VerifyOutcome {
  verdict: CriticVerdict | null;
  error?: string;
  timedOut: boolean;
  /** Пользователь прервал ход: это не деградация и не повод для строки в ленте. */
  aborted?: boolean;
  durationMs: number;
  stages: CriticStage[];
}

/** Что нужно для безопасного вызова верификатора. */
export interface CriticVerifyOptions {
  verify: (
    pack: EvidencePack,
    signal?: AbortSignal,
    onStage?: (stage: CriticStage) => void,
  ) => Promise<CriticVerdict | null>;
  buildPack: (deps: CriticGateDeps) => EvidencePack;
  budgetMs?: number;
  signal?: AbortSignal;
}

/** Fail-open: битый/перебюджетный критик не блокирует агента. */
export async function verifySafely(
  deps: CriticGateDeps,
  opts: CriticVerifyOptions,
): Promise<VerifyOutcome> {
  const budget = opts.budgetMs;
  const stages: CriticStage[] = [];
  let lastStageLine = "";
  // Долгая проверка перестаёт молчать: одна строка, только если реально ждём.
  const stopNotice = noticeAfter(CRITIC_SLOW_NOTICE_MS, () =>
    deps.onMeta?.(`\n${t("ui.critic_checking")}\n`, "progress"),
  );
  const started = Date.now();
  const onStage = (stage: CriticStage): void => {
    stages.push(stage);
    // Прогресс по проходам: видно, что именно занимает время (проверки/финал),
    // и не приходится гадать, чем занят критик. Статус-строка заменяется.
    const line = criticStageLine(stage);
    if (!line || line === lastStageLine) return;
    lastStageLine = line;
    deps.onMeta?.(`\n${line}\n`, "progress");
  };
  try {
    const out = await runWithBudget(
      (signal) => opts.verify(opts.buildPack(deps), signal, onStage),
      budget,
      opts.signal,
    );
    if (out.aborted || opts.signal?.aborted) {
      return {
        verdict: null,
        aborted: true,
        timedOut: false,
        durationMs: out.durationMs,
        stages,
      };
    }
    if (out.timedOut) {
      // Ход не ждёт провайдера, который не слушает signal. Отказ записан:
      // молчаливый pass неотличим от «проверил и сказал ок».
      const cause = `turn_budget (${budget}ms)`;
      deps.logger.diagnostic("warn", `Critic verify exceeded gate budget (fail-open): ${cause}`);
      return {
        verdict: null,
        error: cause,
        timedOut: true,
        durationMs: out.durationMs,
        stages,
      };
    }
    return { verdict: out.value, timedOut: false, durationMs: out.durationMs, stages };
  } catch (err) {
    if (opts.signal?.aborted) {
      return {
        verdict: null,
        aborted: true,
        timedOut: false,
        durationMs: Date.now() - started,
        stages,
      };
    }
    // Одинокий critic_check без вердикта неотличим от pass — фиксируем
    // fail-open диагностикой, чтобы разбор сессии не упирался в "критик завис?".
    const cause = String((err as Error)?.message ?? err);
    deps.logger.diagnostic("warn", `Critic verify failed (fail-open): ${cause}`);
    return {
      verdict: null,
      error: cause,
      timedOut: false,
      durationMs: Date.now() - started,
      stages,
    };
  } finally {
    stopNotice();
  }
}
