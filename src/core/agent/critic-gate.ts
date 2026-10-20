/** Вентиль контр-агента (критика): проверка работы перед финалом. */
import { t } from "../../i18n/index";
import type { Logger } from "../../logger/app-logger";
import type { ContextManager } from "../../core/context/manager";
import type { CriticIssue, CriticVerdict, EvidencePack } from "../../modules/critic/types";
import { normalizedSignature, syntheticIssue } from "../../modules/critic/issue-key";
import type { SessionLogger } from "../session-logger";
import type { OnMeta } from "../types";
import type { LoopState } from "./loop-state";

export { normalizedSignature } from "../../modules/critic/issue-key";

/**
 * Жёсткий кап СОВЕТНЫХ кругов за ход (не конфиг — такой же внутренний
 * потолок, как `MAX_CRITIC_CHECKS`). Совет отдельён от ремонта, чтобы
 * `concern` не крал бюджет `critical` (maxRepairCycles).
 */
const MAX_CRITIC_ADVICE_CYCLES = 1;

/** Зависимости вентиля критика: состояние, логгеры, события тулов хода. */
export interface CriticGateDeps {
  state: LoopState;
  iteration: number;
  logger: Logger;
  contextManager: ContextManager;
  slog: SessionLogger;
  task: string;
  planSummary?: string;
  toolEvents: Array<{ tool: string; args?: Record<string, unknown>; ok?: boolean; output?: string }>;
  /** True, если проверка идёт прямо перед принятием финального ответа. */
  beforeFinish: boolean;
  /**
   * Финальный текст ответа (для ходов без work-мутаций — чат-доставка).
   * Обрезается и редактируется в buildEvidencePack, не раньше.
   */
  answerText?: string;
  /**
   * Мета-канал для `retract`: repair/advice отклоняет уже отстримленный
   * черновик, потребители убирают его до переответа (иначе дубль в ленте).
   */
  onMeta?: OnMeta;
}

/** Действие вентиля: пропустить или переспросить модель. */
export type CriticAction = "pass" | "retry";

/** Опции вентиля: лимиты, верификатор и сборщик evidence-пакета. */
export interface CriticGateOptions {
  enabled: boolean;
  maxCalls: number;
  maxRepairCycles: number;
  verify: (pack: EvidencePack, signal?: AbortSignal) => Promise<CriticVerdict | null>;
  buildPack: (deps: CriticGateDeps) => EvidencePack;
  signal?: AbortSignal;
  /**
   * Последняя причина деградации, сообщённая клиентом критика (INV-C4).
   * Клиент знает причину («call_timeout», «обрезано по maxTokens», «не
   * разобрали JSON»), гейт — нет: он видит только `null`. Без этого хука
   * `critic_error` в сессии писал «no verdict returned» — причину отказа
   * было видно только в app-логе.
   */
  degradationReason?: () => string | undefined;
}

function renderIssues(issues: CriticIssue[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `- [${i.severity}] ${i.problem || i.claim}${i.suggestion ? ` → ${i.suggestion}` : ""}`)
    .join("\n");
}

/**
 * True, если вердикт повторяет уже виденные жалобы (вплоть до перефраза
 * на уровне регистра/пунктуации). Вызывать ДО takeFreshIssues.
 */
function isRepeatedVerdict(state: LoopState, issues: CriticIssue[]): boolean {
  return issues.length > 0 && issues.every((i) => state.seenCriticIssues.has(normalizedSignature(i)));
}

/**
 * Вентиль критика: триггерит проверку по работе хода, инжектит вердикт в
 * контекст. Fail-open: сломанный/перебюджетный критик никогда не блокирует
 * агента.
 */
export class CriticGate {
  /** Счётчик советных кругов за ход (гейт живёт один ход). */
  private adviceCycles = 0;

  constructor(private readonly opts: CriticGateOptions) {}

  /**
   * Оценивает ход через критика.
   * @param deps состояние цикла и события тулов; @returns "pass" или "retry".
   */
  async evaluate(deps: CriticGateDeps): Promise<CriticAction> {
    if (!this.shouldRun(deps)) return "pass";

    this.logCheck(deps);
    deps.state.criticCalls++;
    deps.state.mutationsSinceCritic = 0;

    const { verdict, error } = await this.verifySafely(deps);
    if (!verdict) {
      // Вердикта нет — но «critic_check» без записи о verdict неотличим от
      // pass при разборе сессии. Пишем явный отказ: critic_verdict degraded
      // плюс отдельный critic_error (INV-15: «сломался» ≠ «сказал ок»).
      this.logDegraded(deps, error);
      return "pass";
    }
    if (verdict.status === "ok") return "pass";

    // Не-ok вердикт не теряется: `issues` могли не распарситься (чужие имена
    // полей, пустой список), но status + summary — достаточное основание.
    const issues = verdict.issues.length > 0 ? verdict.issues : [syntheticIssue(verdict)];
    // Повтор уже виденной жалобы — считаем ДО takeFreshIssues (он пополняет набор).
    const isRepeat = isRepeatedVerdict(deps.state, issues);
    const fresh = this.takeFreshIssues(deps.state, issues);
    // Логируем НЕ-ok вердикт всегда: «critic_check» без следа о вердикте
    // читается как «проверил и сказал ок» (INV-C2).
    this.logVerdict(deps, verdict, issues.length);

    // Повтор тех же жалоб: ремонт не тратим, но модель должна услышать, что
    // прошлая попытка не прошла (иначе повтор уходит в тишину).
    if (fresh.length === 0) {
      if (this.canAdvise()) {
        this.injectAdvice(deps, issues, true);
        return "retry";
      }
      return "pass";
    }

    if (this.shouldRepair(deps, verdict, isRepeat)) {
      this.injectRepair(deps, verdict, fresh);
      return "retry";
    }
    // `concern` (или critical без бюджета ремонта): совет ДОХОДИТ до модели
    // — иначе инъекция мертва, и вердикт остаётся без последствий (INV-C6).
    if (verdict.status === "concern" && this.canAdvise()) {
      this.injectAdvice(deps, fresh, false);
      return "retry";
    }
    this.logExhausted(deps, verdict);
    return "pass";
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
  private async verifySafely(
    deps: CriticGateDeps,
  ): Promise<{ verdict: CriticVerdict | null; error?: string }> {
    try {
      return { verdict: await this.opts.verify(this.opts.buildPack(deps), this.opts.signal) };
    } catch (err) {
      // Одинокий critic_check без вердикта неотличим от pass — фиксируем
      // fail-open диагностикой, чтобы разбор сессии не упирался в "критик завис?".
      const cause = String((err as Error)?.message ?? err);
      deps.logger.diagnostic("warn", `Critic verify failed (fail-open): ${cause}`);
      return { verdict: null, error: cause };
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

  private logCheck(deps: CriticGateDeps): void {
    // Сводка субъекта проверки: без неё строка `critic_check` в Trace пуста —
    // при вердикте `ok` вердикт вообще не пишется.
    const tools = deps.toolEvents.map((e) => e.tool);
    const unique = [...new Set(tools)];
    const summary =
      `checked ${tools.length} tool call(s)` +
      (unique.length ? `: ${unique.slice(0, 8).join(", ")}` : "");
    deps.slog.logCritic("critic_check", {
      iteration: deps.iteration,
      beforeFinish: deps.beforeFinish,
      mutations: deps.state.mutationsSinceCritic,
      tools: tools.slice(0, 8),
      summary,
    });
  }

  /**
   * Отказ вердикта пишется в `session.jsonl` явно (`degraded: true`) плюс
   * отдельный `critic_error` (INV-15). Fail-open остаётся (критик не блокирует
   * агента), но «проверял и не сказал ничего» больше не выглядит как
   * «проверил и сказал ок».
   * @param cause причина отказа, если verify бросил; иначе — причина от клиента
   *   (`degradationReason`), если он её сообщил; иначе «no verdict returned».
   */
  private logDegraded(deps: CriticGateDeps, cause?: string): void {
    const reason = cause ?? this.opts.degradationReason?.() ?? "no verdict returned";
    deps.slog.logCritic("critic_verdict", {
      status: "none",
      summary: "no verdict (degraded)",
      issueCount: 0,
      degraded: true,
      iteration: deps.iteration,
    });
    deps.slog.logDiagnosticEvent("critic_error", {
      source: "core",
      operation: "critic.verify",
      kind: "degraded",
      cause: reason,
      recoverable: true,
    });
    deps.logger.diagnostic("warn", `Critic returned no verdict (degraded, fail-open): ${reason}`);
  }

  private logVerdict(deps: CriticGateDeps, verdict: CriticVerdict, count: number): void {
    deps.slog.logCritic("critic_verdict", {
      status: verdict.status,
      summary: verdict.summary,
      issueCount: count,
    });
    deps.logger.diagnostic("info", `Critic ${verdict.status}: ${verdict.summary} (${count} issue(s))`);
  }

  /** Бюджеты исчерпаны: вердикт залогирован, ответ принимается как есть. */
  private logExhausted(deps: CriticGateDeps, verdict: CriticVerdict): void {
    deps.logger.diagnostic(
      "warn",
      `Critic ${verdict.status}: ${verdict.summary} - budget exhausted, accepting the answer`,
    );
  }

  /**
   * Совет: инжектит текст и ТРЕБУЕТ нового ответа (retry). Раньше совет
   * инжектился в уже завершающийся ход — модель его не видела, и вердикт
   * оставался без последствий (INV-C6).
   */
  private injectAdvice(deps: CriticGateDeps, issues: CriticIssue[], isRepeat: boolean): void {
    this.adviceCycles++;
    // Черновик уже в ленте — убираем до переответа, иначе дубль.
    deps.onMeta?.(t("ui.draft_retracted"), "retract");
    deps.contextManager.addMessage({
      role: "user",
      content: `<system-summary>${isRepeat
        ? t("critic.repeat", { issues: renderIssues(issues) })
        : t("critic.advice", { issues: renderIssues(issues) })}</system-summary>`,
    });
  }

  /** Починка: тратит repair-бюджет, пишет escalation, ретраит. */
  private injectRepair(deps: CriticGateDeps, verdict: CriticVerdict, fresh: CriticIssue[]): void {
    deps.state.criticRepairCycles++;
    // Черновик уже в ленте — убираем до переответа, иначе дубль.
    deps.onMeta?.(t("ui.draft_retracted"), "retract");
    deps.slog.logCritic("critic_escalation", {
      summary: verdict.summary,
      cycle: deps.state.criticRepairCycles,
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
