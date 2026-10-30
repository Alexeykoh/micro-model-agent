/**
 * Записи вентиля критика (A15): `critic_check`/`critic_verdict` с длительностью
 * и признаком таймаута бюджета гейта. Вынесено из `critic-gate.ts` (правило ≤300).
 */
import type { CriticVerdict } from "../../modules/critic/types";
import type { CriticGateDeps } from "./critic-contract";
import { criticDegradeLine } from "./critic-degrade-line";

/** Субъект проверки + действующий бюджет — до вызова LLM. */
export function logCheck(deps: CriticGateDeps, budgetMs?: number): void {
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
    // Бюджет виден в логе: иначе непонятно, каким потолком резало проверку.
    budgetMs,
  });
}

/** Проверка пропущена: тот же вход, новых жалоб быть не может (A15). */
export function logSkipped(deps: CriticGateDeps): void {
  deps.slog.logCritic("critic_check", {
    iteration: deps.iteration,
    beforeFinish: deps.beforeFinish,
    mutations: deps.state.mutationsSinceCritic,
    summary: "skipped: unchanged pack, no new issues expected",
    skipped: "unchanged_pack",
  });
  deps.logger.diagnostic("info", "Critic check skipped: pack unchanged since the last verdict");
}

/** Чем закончилась проверка: длительность, таймаут бюджета, причина отказа. */
export interface DegradedInfo {
  timedOut: boolean;
  durationMs: number;
  /** Причина от клиента (INV-C4), если он её сообщил. */
  degradationReason?: () => string | undefined;
}

/**
 * Отказ вердикта пишется в `session.jsonl` явно (`degraded: true`) плюс
 * отдельный `critic_error` (INV-15). Fail-open остаётся (критик не блокирует
 * агента), но «проверял и не сказал ничего» больше не выглядит как
 * «проверил и сказал ок».
 * @param cause причина отказа, если verify бросил; иначе — причина от клиента
 *   (`degradationReason`), если он её сообщил; иначе «no verdict returned».
 */
export function logDegraded(
  deps: CriticGateDeps,
  cause: string | undefined,
  info: DegradedInfo,
): void {
  // Таймаут бюджета гейта — причина самого гейта, а не клиента.
  const reason = info.timedOut
    ? (cause ?? "turn_budget")
    : (cause ?? info.degradationReason?.() ?? "no verdict returned");
  deps.slog.logCritic("critic_verdict", {
    status: "none",
    summary: "no verdict (degraded)",
    issueCount: 0,
    degraded: true,
    iteration: deps.iteration,
    duration: info.durationMs,
    ...(info.timedOut ? { timedOut: true } : {}),
  });
  deps.slog.logDiagnosticEvent("critic_error", {
    source: "core",
    operation: "critic.verify",
    kind: "degraded",
    cause: reason,
    recoverable: true,
  });
  deps.logger.diagnostic("warn", `Critic returned no verdict (degraded, fail-open): ${reason}`);
  // Лента обязана знать, что верификации НЕ было: молчаливый pass неотличим
  // от «проверил и сказал ок». Техническая причина остаётся выше — в логе
  // сессии и app-логе; в чат идёт класс причины (STYLE, одна строка).
  deps.onMeta?.(`\n${criticDegradeLine(reason)}\n`, "status");
}

/** Не-ok вердикт: всегда с длительностью — по ней видно цену проверки. */
export function logVerdict(
  deps: CriticGateDeps,
  verdict: CriticVerdict,
  count: number,
  durationMs: number,
): void {
  deps.slog.logCritic("critic_verdict", {
    status: verdict.status,
    summary: verdict.summary,
    issueCount: count,
    iteration: deps.iteration,
    duration: durationMs,
  });
  deps.logger.diagnostic(
    "info",
    `Critic ${verdict.status}: ${verdict.summary} (${count} issue(s), ${durationMs}ms)`,
  );
}

/** Бюджеты исчерпаны: вердикт залогирован, ответ принимается как есть. */
export function logExhausted(deps: CriticGateDeps, verdict: CriticVerdict): void {
  deps.logger.diagnostic(
    "warn",
    `Critic ${verdict.status}: ${verdict.summary} - budget exhausted, accepting the answer`,
  );
}
