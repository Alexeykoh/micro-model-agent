/**
 * Single-turn agent runner for `mma web`.
 *
 * Split out of `module.ts` (rule #1: ≤300 lines/file). Owns the per-turn
 * bookkeeping the SSE forwarder needs: tool-call id matching (`ToolEvent`
 * carries no id, so one is synthesized per `start` and matched LIFO on `end`),
 * the interrupt flag (`AgentResult` has no `interrupted` field) and the usage
 * capture feeding the sidebar.
 */
import type { Agent } from "../../core/agent";
import type { ToolEvent } from "../../core/types";
import type { ToolCall, ToolResult } from "../../tools/types";
import type { SessionManager } from "../../modules/session/manager";
import type { ExecutionModule } from "../../modules/execution/module";
import { broadcast, type WebUiState } from "./state";
import { captureUsage, planEventFor } from "./host-state";
import { cancelPendingQuestions } from "./prompt-io";
import type { Forwarder } from "./forward";

export interface RunAgentDeps {
  agent: Agent;
  state: WebUiState;
  forwarder: Forwarder;
  sessionManager?: Pick<SessionManager, "getActiveMeta">;
  execModule?: Pick<ExecutionModule, "getActivePlan">;
  /** Sidebar usage fallback when the turn reports no limit. */
  contextWindow?: number;
}

export interface RunAgent {
  /** Run one turn; owns every SSE event of it for the starting session. */
  run: (text: string) => Promise<unknown>;
  /** Mark interrupted, unblock pending questions, shut the agent down. */
  interrupt: () => void;
}

export function makeRunAgent(deps: RunAgentDeps): RunAgent {
  const { agent, state, forwarder } = deps;

  // `ToolEvent` is renderer-oriented and carries no id. Synthesize one per
  // `start` and match it on `end` (LIFO per tool name) so the browser can pair
  // tool_start/tool_end cards (correction #1).
  const pendingIds = new Map<string, string[]>();
  let toolSeq = 0;
  const startId = (tool: string): string => {
    const id = `t${++toolSeq}`;
    const stack = pendingIds.get(tool) ?? [];
    stack.push(id);
    pendingIds.set(tool, stack);
    return id;
  };
  const endId = (tool: string): string => pendingIds.get(tool)?.pop() ?? `t-stray-${++toolSeq}`;
  const callFor = (ev: ToolEvent, id: string): ToolCall => ({
    id,
    name: ev.tool,
    arguments: ev.args,
  });
  const resultFor = (ev: ToolEvent): ToolResult => ({
    success: !ev.error,
    output: ev.output ?? "",
  });

  // `AgentResult` has no `interrupted` field and `agent.shutdown()` may still
  // return `success: true`, so track the interrupt locally. The REPL interrupts
  // via `agent.shutdown()` (repl.ts `interruptRun`); we match it.
  let interrupted = false;
  let toolCalls = 0;

  const run = async (text: string): Promise<unknown> => {
    interrupted = false;
    toolCalls = 0;
    state.agentRunning = true;
    // Own every event of this turn for the session that started it, so SSE
    // output routes to the right browser tab even if the user switches tabs.
    state.activeSessionId = deps.sessionManager?.getActiveMeta()?.id;
    try {
      const result = await agent.run(
        text,
        (chunk) => forwarder.onText(chunk),
        (meta, kind) => forwarder.onMeta(meta, kind),
        (ev) => {
          if (ev.type === "start") {
            forwarder.onToolStart(callFor(ev, startId(ev.tool)));
          } else {
            toolCalls++;
            forwarder.onToolEnd(callFor(ev, endId(ev.tool)), resultFor(ev), ev.duration ?? 0);
            // A finished `plan`/`todo` tool refreshes the feed's plan card; the
            // sidebar keeps its own `/api/state` projection.
            const plan = planEventFor(ev.tool, deps.execModule);
            if (plan) forwarder.onPlan(plan);
          }
        },
        (phase) => forwarder.onPhase(phase),
        (reasoning) => forwarder.onReasoning(reasoning),
      );
      // Capture usage before `onTurnEnd` so a `state` broadcast right after the
      // turn already carries the fresh sidebar metrics (the client also polls
      // `/api/state`, so this is an optimization, not the only path).
      state.usage = captureUsage(result, deps.contextWindow);
      forwarder.onTurnEnd({
        success: result.success,
        durationMs: result.durationMs,
        toolCalls,
        interrupted: interrupted || undefined,
      });
      broadcast({ type: "state", ts: Date.now(), busy: state.busy, usage: state.usage }, state);
      return result;
    } catch (err) {
      forwarder.onTurnEnd({ success: false, interrupted: interrupted || undefined });
      throw err;
    }
  };

  const interrupt = (): void => {
    interrupted = true;
    // Unblock any tool waiting on a browser answer before the turn unwinds.
    cancelPendingQuestions(state);
    agent.shutdown();
  };

  return { run, interrupt };
}
