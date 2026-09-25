import { t } from "../../i18n/index";
import type { Logger } from "../../logger/app-logger";
import type { ContextManager } from "../../modules/context/manager";
import type { CriticIssue, CriticVerdict, EvidencePack } from "../../modules/critic/types";
import type { SessionLogger } from "../session-logger";
import type { LoopState } from "./loop-state";

const MUTATIONS_BEFORE_CHECK = 3;

export interface CriticGateDeps {
  state: LoopState;
  iteration: number;
  logger: Logger;
  contextManager: ContextManager;
  slog: SessionLogger;
  task: string;
  planSummary?: string;
  toolEvents: Array<{ tool: string; args?: Record<string, unknown>; ok?: boolean }>;
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

    deps.state.criticCalls++;
    deps.state.mutationsSinceCritic = 0;

    const verdict = await this.opts.verify(this.opts.buildPack(deps), this.opts.signal);
    if (!verdict || verdict.status === "ok") return "pass";

    const fresh = this.takeFreshIssues(deps.state, verdict.issues);
    if (fresh.length === 0) return "pass";

    this.logVerdict(deps, verdict, fresh.length);
    this.inject(deps, verdict, fresh);
    return "retry";
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

  private logVerdict(deps: CriticGateDeps, verdict: CriticVerdict, count: number): void {
    deps.slog.logCritic("critic_verdict", {
      status: verdict.status,
      summary: verdict.summary,
      issueCount: count,
    });
    deps.logger.info(`Critic ${verdict.status}: ${verdict.summary} (${count} issue(s))`);
  }

  private inject(deps: CriticGateDeps, verdict: CriticVerdict, fresh: CriticIssue[]): void {
    const canRepair =
      verdict.status === "critical" &&
      deps.beforeFinish &&
      deps.state.criticRepairCycles < this.opts.maxRepairCycles;
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
