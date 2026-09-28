import { t } from "../../i18n/index";
import type { Logger } from "../../logger/app-logger";
import type { ContextManager } from "../../modules/context/manager";
import type { CriticIssue, CriticVerdict, EvidencePack } from "../../modules/critic/types";
import type { SessionLogger } from "../session-logger";
import type { LoopState } from "./loop-state";

const MUTATIONS_BEFORE_CHECK = 3;

/** Tail of a tool output attached to an evidence event (bounded — the critic call has its own budget). */
const MAX_EVENT_OUTPUT_CHARS = 600;

export interface CriticGateDeps {
  state: LoopState;
  iteration: number;
  logger: Logger;
  contextManager: ContextManager;
  slog: SessionLogger;
  task: string;
  planSummary?: string;
  toolEvents: Array<{ tool: string; args?: Record<string, unknown>; ok?: boolean; output?: string }>;
  /** True when evaluated right before the loop would accept the final answer. */
  beforeFinish: boolean;
}

export type CriticAction = "pass" | "retry";

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

function renderIssues(issues: CriticIssue[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `- [${i.severity}] ${i.problem || i.claim}${i.suggestion ? ` → ${i.suggestion}` : ""}`)
    .join("\n");
}

export class CriticGate {
  constructor(private readonly opts: CriticGateOptions) {}

  async evaluate(deps: CriticGateDeps): Promise<CriticAction> {
    if (!this.shouldRun(deps)) return "pass";

    this.logCheck(deps);
    deps.state.criticCalls++;
    deps.state.mutationsSinceCritic = 0;

    const verdict = await this.verifySafely(deps);
    if (!verdict || verdict.status === "ok") return "pass";

    const fresh = this.takeFreshIssues(deps.state, verdict.issues);
    if (fresh.length === 0) return "pass";

    this.logVerdict(deps, verdict, fresh.length);
    const canRepair =
      verdict.status === "critical" &&
      deps.beforeFinish &&
      deps.state.criticRepairCycles < this.opts.maxRepairCycles;
    this.inject(deps, verdict, fresh, canRepair);
    return "retry";
  }

  /** Fail open: a broken/over-budget critic must never block the agent. */
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
    if (!deps.beforeFinish && deps.state.mutationsSinceCritic < MUTATIONS_BEFORE_CHECK) {
      return false;
    }
    return deps.toolEvents.length !== 0;
  }

  private takeFreshIssues(state: LoopState, issues: CriticIssue[]): CriticIssue[] {
    const fresh: CriticIssue[] = [];
    for (const issue of issues) {
      const sig = issueSignature(issue);
      if (state.seenCriticIssues.has(sig)) continue;
      state.seenCriticIssues.add(sig);
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

  private inject(
    deps: CriticGateDeps,
    verdict: CriticVerdict,
    fresh: CriticIssue[],
    canRepair: boolean,
  ): void {
    if (!canRepair) {
      deps.contextManager.addMessage({
        role: "user",
        content: `<system-summary>${t("critic.advice", { issues: renderIssues(fresh) })}</system-summary>`,
      });
      return;
    }

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

export function gatherTurnToolEvents(contextManager: {
  getActiveHistory: () => Array<{
    role: string;
    name?: string;
    content?: unknown;
    success?: boolean;
    arguments?: Record<string, unknown>;
  }>;
}): Array<{ tool: string; args?: Record<string, unknown>; ok?: boolean; output?: string }> {
  const events: Array<{ tool: string; args?: Record<string, unknown>; ok?: boolean; output?: string }> = [];
  for (const m of contextManager.getActiveHistory()) {
    if (m.role !== "tool" || !m.name) continue;
    // role:"tool" messages already carry the call arguments (tool-batch)
    // and the (budget-truncated) output — pass both through so the critic
    // sees WHAT was touched and WHAT came back, not just bare tool names.
    // Without args the evidence pack is blind (changedFiles/commands always
    // empty) and the critic must return "ok" for lack of evidence.
    const output = typeof m.content === "string" ? m.content.slice(-MAX_EVENT_OUTPUT_CHARS) : undefined;
    events.push({ tool: m.name, args: m.arguments, ok: m.success, output });
  }
  return events;
}
