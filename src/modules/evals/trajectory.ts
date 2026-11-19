/**
 * Trajectory-чеки evals (P0 Evals 1/2): детерминированная оценка хода
 * по `session.jsonl` (без LLM-судьи). См. спеку `2026-11-09-evals-design.md`.
 */

export interface TrajectoryEvent {
  type?: string;
  tool?: string;
  name?: string;
  content?: string;
  role?: string;
  success?: boolean;
  error?: string;
}

export interface TrajectoryExpectations {
  /** Тулы, обязанные встретиться (хотя бы раз). */
  requiredTools?: string[];
  /** Тулы, обязанные не встретиться. */
  forbiddenTools?: string[];
  /** Порядок обязательных тулз (подпоследовательность трассы). */
  order?: string[];
  /** Подстроки, обязанные быть в финальном тексте. */
  needlesInAnswer?: string[];
  /** Максимально допустимые неудачные тул-вызовы. */
  maxToolFailures?: number;
}

export interface TrajectoryVerdict {
  passed: boolean;
  reasons: string[];
  toolTrace: string[];
  failures: string[];
}

/** Трасса вызовов из session-лог событий (`tool_call`/`tool_result`). */
export function extractToolTrace(events: TrajectoryEvent[]): string[] {
  const trace: string[] = [];
  for (const e of events) {
    if (e.type === "tool_call") {
      trace.push(e.tool ?? e.name ?? "unknown");
    }
  }
  return trace;
}

/** Оценка траектории по ожиданиям (чистая, без I/O). */
export function gradeTrajectory(
  events: TrajectoryEvent[],
  exp: TrajectoryExpectations,
): TrajectoryVerdict {
  const reasons: string[] = [];
  const trace = extractToolTrace(events);
  const seen = new Set(trace);

  for (const tool of exp.requiredTools ?? []) {
    if (!seen.has(tool)) reasons.push(`required tool missing: ${tool}`);
  }
  for (const tool of exp.forbiddenTools ?? []) {
    if (seen.has(tool)) reasons.push(`forbidden tool used: ${tool}`);
  }
  if (exp.order?.length) {
    let cursor = 0;
    for (const name of trace) {
      if (cursor < exp.order.length && name === exp.order[cursor]) cursor++;
    }
    if (cursor !== exp.order.length) reasons.push(`order broken: ${exp.order.join(" < ")}`);
  }

  const answer = events
    .filter((e) => e.role === "assistant")
    .map((e) => String(e.content ?? ""))
    .join("\n");
  for (const needle of exp.needlesInAnswer ?? []) {
    if (!answer.includes(needle)) reasons.push(`needle missing in final answer: ${needle}`);
  }

  const failures = events
    .filter((e) => (e.type === "tool_result" || e.type === "tool-result") && e.success === false)
    .map((e) => e.tool ?? "unknown");
  const maxFailures = exp.maxToolFailures ?? Number.POSITIVE_INFINITY;
  if (failures.length > maxFailures) {
    reasons.push(`too many tool failures: ${failures.length} > ${maxFailures}`);
  }

  return { passed: reasons.length === 0, reasons, toolTrace: trace, failures };
}
