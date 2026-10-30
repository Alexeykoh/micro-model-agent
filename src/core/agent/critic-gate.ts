/** Вентиль контр-агента (критика): проверка работы перед финалом. */
import { t } from "../../i18n/index";
import type { CriticIssue, CriticVerdict } from "../../modules/critic/types";
import { normalizedSignature, syntheticIssue } from "../../modules/critic/issue-key";
import type { CriticAction, CriticGateDeps, CriticGateOptions } from "./critic-contract";
import { announceRetract, criticRetractInfo } from "./draft-retract";
import { packFingerprint, runWithBudget } from "./critic-budget";
import { noticeAfter } from "./slow-notice";
import { CRITIC_SLOW_NOTICE_MS } from "../../config/timeouts";
import type { LoopState } from "./loop-state";
import { isRepeatedVerdict, renderIssues } from "./critic-issues";
import { logCheck, logDegraded, logExhausted, logSkipped, logVerdict } from "./critic-gate-log";

export type { CriticAction, CriticGateDeps, CriticGateOptions } from "./critic-contract";

export { normalizedSignature } from "../../modules/critic/issue-key";

/** Итог одной проверки: вердикт (или null), причина отказа, признак таймаута, мс. */
interface VerifyOutcome {
  verdict: CriticVerdict | null;
  error?: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Жёсткий кап СОВЕТНЫХ кругов за ход (не конфиг — такой же внутренний
 * потолок, как `MAX_CRITIC_CHECKS`). Совет отдельён от ремонта, чтобы
 * `concern` не крал бюджет `critical` (maxRepairCycles).
 */
const MAX_CRITIC_ADVICE_CYCLES = 1;

/**
 * Вентиль критика: триггерит проверку по работе хода, инжектит вердикт в
 * контекст. Fail-open: сломанный/перебюджетный критик никогда не блокирует
 * агента.
 */
export class CriticGate {
  /** Счётчик советных кругов за ход (гейт живёт один ход). */
  private adviceCycles = 0;
  /** Отпечаток входа прошлой проверки — база для отказа от повторного вызова. */
  private lastFingerprint: string | undefined;
  /**
   * Прошлый вердикт был не-ok, и все его жалобы уже показаны модели. Повторная
   * проверка того же входа добавить нечего: тот же набор жалоб уже в наборе.
   */
  private lastVerdictNonOk = false;

  constructor(private readonly opts: CriticGateOptions) {}

  /**
   * Оценивает ход через критика.
   * @param deps состояние цикла и события тулов; @returns "pass" или "retry".
   */
  async evaluate(deps: CriticGateDeps): Promise<CriticAction> {
    if (!this.shouldRun(deps)) return "pass";

    // Тот же вход и сказать больше нечего — платить LLM-вызов не за что (A15).
    const fingerprint = packFingerprint(deps);
    if (this.canSkip(fingerprint)) {
      logSkipped(deps);
      return "pass";
    }

    logCheck(deps, this.opts.budgetMs);
    deps.state.criticCalls++;
    deps.state.mutationsSinceCritic = 0;

    const outcome = await this.verifySafely(deps);
    this.lastFingerprint = fingerprint;
    if (!outcome.verdict) {
      // Вердикта нет — но «critic_check» без записи о verdict неотличим от
      // pass при разборе сессии. Пишем явный отказ: critic_verdict degraded
      // плюс отдельный critic_error (INV-15: «сломался» ≠ «сказал ок»).
      logDegraded(deps, outcome.error, {
        timedOut: outcome.timedOut,
        durationMs: outcome.durationMs,
        degradationReason: this.opts.degradationReason,
      });
      return "pass";
    }
    if (outcome.verdict.status === "ok") {
      this.lastVerdictNonOk = false;
      return "pass";
    }

    // Не-ok вердикт не теряется: `issues` могли не распарситься (чужие имена
    // полей, пустой список), но status + summary — достаточное основание.
    const issues =
      outcome.verdict.issues.length > 0
        ? outcome.verdict.issues
        : [syntheticIssue(outcome.verdict)];
    // Повтор уже виденной жалобы — считаем ДО takeFreshIssues (он пополняет набор).
    const isRepeat = isRepeatedVerdict(deps.state, issues);
    const fresh = this.takeFreshIssues(deps.state, issues);
    // Логируем НЕ-ok вердикт всегда: «critic_check» без следа о вердикте
    // читается как «проверил и сказал ок» (INV-C2).
    logVerdict(deps, outcome.verdict, issues.length, outcome.durationMs);
    this.lastVerdictNonOk = true;

    // Повтор тех же жалоб: ремонт не тратим, но модель должна услышать, что
    // прошлая попытка не прошла (иначе повтор уходит в тишину).
    if (fresh.length === 0) {
      if (this.canAdvise()) {
        this.injectAdvice(deps, outcome.verdict, issues, true);
        return "retry";
      }
      return "pass";
    }

    if (this.shouldRepair(deps, outcome.verdict, isRepeat)) {
      this.injectRepair(deps, outcome.verdict, fresh, outcome.durationMs);
      return "retry";
    }
    // `concern` (или critical без бюджета ремонта): совет ДОХОДИТ до модели
    // — иначе инъекция мертва, и вердикт остаётся без последствий (INV-C6).
    if (outcome.verdict.status === "concern" && this.canAdvise()) {
      this.injectAdvice(deps, outcome.verdict, fresh, false);
      return "retry";
    }
    logExhausted(deps, outcome.verdict);
    return "pass";
  }

  /**
   * Повторный вызов на неизменном входе, когда добавить нечего: советный цикл
   * уже израсходован, а прошлый вердикт был не-ok — те же жалобы уже показаны.
   */
  private canSkip(fingerprint: string): boolean {
    return this.lastFingerprint === fingerprint && this.lastVerdictNonOk && !this.canAdvise();
  }

  /** Починка положена только свежему critical в пределах repair-бюджета. */
  private shouldRepair(deps: CriticGateDeps, verdict: CriticVerdict, isRepeat: boolean): boolean {
    return (
      verdict.status === "critical" &&
      deps.beforeFinish &&
      deps.state.criticRepairCycles < this.opts.maxRepairCycles &&
      !isRepeat
    );
  }

  /** Остался ли ещё один советный круг. */
  private canAdvise(): boolean {
    return this.adviceCycles < MAX_CRITIC_ADVICE_CYCLES;
  }

  /** Fail-open: битый/перебюджетный критик не блокирует агента. */
  private async verifySafely(deps: CriticGateDeps): Promise<VerifyOutcome> {
    const budget = this.opts.budgetMs;
    // Долгая проверка перестаёт молчать: одна строка, только если реально ждём.
    const stopNotice = noticeAfter(CRITIC_SLOW_NOTICE_MS, () =>
      deps.onMeta?.(`\n${t("ui.critic_checking")}\n`, "progress"),
    );
    const started = Date.now();
    try {
      const out = await runWithBudget(
        (signal) => this.opts.verify(this.opts.buildPack(deps), signal),
        budget,
        this.opts.signal,
      );
      if (out.timedOut) {
        // Ход не ждёт провайдера, который не слушает signal. Отказ записан:
        // молчаливый pass неотличим от «проверил и сказал ок».
        const cause = `turn_budget (${budget}ms)`;
        deps.logger.diagnostic("warn", `Critic verify exceeded gate budget (fail-open): ${cause}`);
        return { verdict: null, error: cause, timedOut: true, durationMs: out.durationMs };
      }
      return { verdict: out.value, timedOut: false, durationMs: out.durationMs };
    } catch (err) {
      // Одинокий critic_check без вердикта неотличим от pass — фиксируем
      // fail-open диагностикой, чтобы разбор сессии не упирался в "критик завис?".
      const cause = String((err as Error)?.message ?? err);
      deps.logger.diagnostic("warn", `Critic verify failed (fail-open): ${cause}`);
      return { verdict: null, error: cause, timedOut: false, durationMs: Date.now() - started };
    } finally {
      stopNotice();
    }
  }

  private shouldRun(deps: CriticGateDeps): boolean {
    if (!this.opts.enabled) return false;
    if (deps.state.criticCalls >= this.opts.maxCalls) return false;
    // Единственный вызов — перед финалом (beforeFinish, см. agent.ts):
    // mid-turn ветки по mutationsSinceCritic нет, счётчик — только лог-поле.
    if (!deps.beforeFinish) return false;
    // Проверять нечего: ни работы тулами, ни ответа для оценки. Чат-доставка
    // (ответ без файлов) — тоже предмет проверки (INV-C7).
    if (deps.toolEvents.length === 0 && !deps.answerText?.trim()) return false;
    return true;
  }

  private takeFreshIssues(state: LoopState, issues: CriticIssue[]): CriticIssue[] {
    const fresh: CriticIssue[] = [];
    for (const issue of issues) {
      const sig = normalizedSignature(issue);
      if (state.seenCriticIssues.has(sig)) continue;
      state.seenCriticIssues.add(sig);
      fresh.push(issue);
    }
    return fresh;
  }

  /**
   * Совет: инжектит текст и ТРЕБУЕТ нового ответа (retry). Раньше совет
   * инжектился в уже завершающийся ход — модель его не видела, и вердикт
   * оставался без последствий (INV-C6).
   */
  private injectAdvice(
    deps: CriticGateDeps,
    verdict: CriticVerdict,
    issues: CriticIssue[],
    isRepeat: boolean,
  ): void {
    this.adviceCycles++;
    // Черновик уже в ленте — убираем до переответа, иначе дубль.
    announceRetract(deps.onMeta, criticRetractInfo(verdict, issues, deps.iteration), deps.slog);
    deps.contextManager.addMessage({
      role: "user",
      content: `<system-summary>${
        isRepeat
          ? t("critic.repeat", { issues: renderIssues(issues) })
          : t("critic.advice", { issues: renderIssues(issues) })
      }</system-summary>`,
    });
  }

  /** Починка: тратит repair-бюджет, пишет escalation, ретраит. */
  private injectRepair(
    deps: CriticGateDeps,
    verdict: CriticVerdict,
    fresh: CriticIssue[],
    durationMs: number,
  ): void {
    deps.state.criticRepairCycles++;
    // Черновик уже в ленте — убираем до переответа, иначе дубль.
    announceRetract(deps.onMeta, criticRetractInfo(verdict, fresh, deps.iteration), deps.slog);
    deps.slog.logCritic("critic_escalation", {
      summary: verdict.summary,
      cycle: deps.state.criticRepairCycles,
      duration: durationMs,
    });
    deps.contextManager.addMessage({
      role: "user",
      content: `<system-summary>${t("critic.repair", {
        summary: verdict.summary,
        issues: renderIssues(fresh),
      })}</system-summary>`,
    });
  }
}
