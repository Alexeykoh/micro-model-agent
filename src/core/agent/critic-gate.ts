/** Вентиль контр-агента (критика): проверка мутаций перед финалом. */
import { t } from "../../i18n/index";
import type { Logger } from "../../logger/app-logger";
import type { ContextManager } from "../../modules/context/manager";
import type { CriticIssue, CriticVerdict, EvidencePack } from "../../modules/critic/types";
import type { SessionLogger } from "../session-logger";
import type { LoopState } from "./loop-state";

/** Хвост вывода тула в evidence-событии (ограничен — у критика свой бюджет). */
const MAX_EVENT_OUTPUT_CHARS = 600;

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
}

function issueSignature(issue: CriticIssue): string {
  return `${issue.severity}:${issue.claim}`.toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

/**
 * Грубая нормализация жалобы для ловли near-identical повторов (регистр,
 * пунктуация, пробелы). Настоящие перефразы («ran weather searches» vs
 * «ignored the task») этим не ловятся — их останавливает advice=pass
 * при исчерпанном repair-бюджете, а не эта эвристика.
 */
export function normalizedSignature(issue: CriticIssue): string {
  const body = `${issue.severity}:${issue.claim}`
    .toLowerCase()
    .replace(/[^a-z0-9а-яё\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `~${body}`;
}

function renderIssues(issues: CriticIssue[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `- [${i.severity}] ${i.problem || i.claim}${i.suggestion ? ` → ${i.suggestion}` : ""}`)
    .join("\n");
}

/**
 * Вентиль критика: триггерит проверку по мутациям, инжектит вердикт в контекст.
 * Fail-open: сломанный/перебюджетный критик никогда не блокирует агента.
 */
export class CriticGate {
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

    const verdict = await this.verifySafely(deps);
    if (!verdict || verdict.status === "ok") return "pass";

    // Повтор уже виденной жалобы — считаем ДО takeFreshIssues (он пополняет набор).
    const isRepeat =
      verdict.issues.length > 0 &&
      verdict.issues.every((i) => deps.state.seenCriticIssues.has(normalizedSignature(i)));
    const fresh = this.takeFreshIssues(deps.state, verdict.issues);
    if (fresh.length === 0) return "pass";

    this.logVerdict(deps, verdict, fresh.length);
    const canRepair =
      verdict.status === "critical" &&
      deps.beforeFinish &&
      deps.state.criticRepairCycles < this.opts.maxRepairCycles;
    if (!canRepair || isRepeat) {
      // Совет/повтор — не retry: иначе advice крутит модель по кругу до
      // maxCalls теми же ответами (наблюдалось: 4 идентичных critical подряд).
      // Повтор дополнительно требует сменить подход, repair-бюджет не тратится.
      this.injectRepeatOrAdvice(deps, verdict, fresh, isRepeat);
      return "pass";
    }

    this.injectRepair(deps, verdict, fresh);
    return "retry";
  }

  /** Fail-open: битый/перебюджетный критик не блокирует агента. */
  private async verifySafely(deps: CriticGateDeps): Promise<CriticVerdict | null> {
    try {
      return await this.opts.verify(this.opts.buildPack(deps), this.opts.signal);
    } catch {
      return null;
    }
  }

  private shouldRun(deps: CriticGateDeps): boolean {
    if (!this.opts.enabled) return false;
    if (deps.state.criticCalls >= this.opts.maxCalls) return false;
    // Единственный вызов — перед финалом (beforeFinish, см. agent.ts):
    // mid-turn ветки по mutationsSinceCritic нет, счётчик — только лог-поле.
    // Чистый чат (нет тул-событий текущего захода) — нечего верифицировать,
    // pass без LLM-вызова, бюджет не тратится.
    if (!deps.beforeFinish) return false;
    return deps.toolEvents.length !== 0;
  }

  private takeFreshIssues(state: LoopState, issues: CriticIssue[]): CriticIssue[] {
    const fresh: CriticIssue[] = [];
    for (const issue of issues) {
      const sig = issueSignature(issue);
      if (state.seenCriticIssues.has(sig)) continue;
      state.seenCriticIssues.add(sig);
      state.seenCriticIssues.add(normalizedSignature(issue));
      fresh.push(issue);
    }
    return fresh;
  }

  private logCheck(deps: CriticGateDeps): void {
    deps.slog.logCritic("critic_check", {
      iteration: deps.iteration,
      beforeFinish: deps.beforeFinish,
      mutations: deps.state.mutationsSinceCritic,
      tools: deps.toolEvents.map((e) => e.tool).slice(0, 8),
    });
  }

  private logVerdict(deps: CriticGateDeps, verdict: CriticVerdict, count: number): void {
    deps.slog.logCritic("critic_verdict", {
      status: verdict.status,
      summary: verdict.summary,
      issueCount: count,
    });
    deps.logger.diagnostic("info", `Critic ${verdict.status}: ${verdict.summary} (${count} issue(s))`);
  }

  /** Совет или директива при повторе: инжектит текст, но НЕ ретраит (возврат — pass). */
  private injectRepeatOrAdvice(
    deps: CriticGateDeps,
    verdict: CriticVerdict,
    fresh: CriticIssue[],
    isRepeat: boolean,
  ): void {
    deps.contextManager.addMessage({
      role: "user",
      content: `<system-summary>${isRepeat
        ? t("critic.repeat", { issues: renderIssues(fresh) })
        : t("critic.advice", { issues: renderIssues(fresh) })}</system-summary>`,
    });
  }

  /** Починка: тратит repair-бюджет, пишет escalation, ретраит. */
  private injectRepair(deps: CriticGateDeps, verdict: CriticVerdict, fresh: CriticIssue[]): void {
    deps.state.criticRepairCycles++;
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

/**
 * Собирает события тулов текущего захода из активной истории (для evidence-пакета критика).
 * @param contextManager менеджер с getActiveHistory;
 * @param fromIndex маркер начала захода (длина истории на старте run'а) — всё, что раньше,
 *   принадлежит прошлым вопросам и в пакет не входит; клампится к длине (компакция ужимает историю).
 * @returns события role:"tool" начиная с маркера.
 */
export function gatherTurnToolEvents(
  contextManager: {
    getActiveHistory: () => Array<{
      role: string;
      name?: string;
      content?: unknown;
      success?: boolean;
      arguments?: Record<string, unknown>;
    }>;
  },
  fromIndex = 0,
): Array<{ tool: string; args?: Record<string, unknown>; ok?: boolean; output?: string }> {
  const events: Array<{ tool: string; args?: Record<string, unknown>; ok?: boolean; output?: string }> = [];
  const history = contextManager.getActiveHistory();
  const start = Math.max(0, Math.min(fromIndex, history.length));
  for (const m of history.slice(start)) {
    if (m.role !== "tool" || !m.name) continue;
    // Сообщения role:"tool" уже несут аргументы (tool-batch) и обрезанный
    // вывод — пробрасываем оба, чтобы критик видел ЧТО тронуто и ЧТО вернулось.
    // Без аргументов пакет слеп (changedFiles/commands пусты) и критик
    // вынужден вернуть "ok" за отсутствием улик.
    const output = typeof m.content === "string" ? m.content.slice(-MAX_EVENT_OUTPUT_CHARS) : undefined;
    events.push({ tool: m.name, args: m.arguments, ok: m.success, output });
  }
  return events;
}
