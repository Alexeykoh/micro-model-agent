/**
 * `mma web` module: the only place that knows about `Agent`.
 *
 * The server (`./server`) and forwarder (`./forward`) stay transport-pure; this
 * file wires the agent loop's callback surface into the SSE forwarder and hands
 * the resulting `Host` to the server.
 *
 * Single-flight (correction #2): the `WebUiState` is created FIRST so the
 * `WebHost`'s busy predicate and the server share ONE state object. The server
 * reserves `busy = true` synchronously on submit; `runAgent` marks
 * `agentRunning = true` once the turn actually starts; the forwarder resets
 * both on `turn_end`. The host guard uses `agentRunning` (not `busy`) so the
 * owner's `submit` is not rejected by the server's own reservation.
 */
import type { Agent } from "../../core/agent";
import type { AppConfig } from "../../config/types";
import type { SessionManager } from "../../modules/session/manager";
import type { ExecutionModule } from "../../modules/execution/module";
import type { Host, HostStateSnapshot } from "../../core/host";
import type { ToolEvent } from "../../core/types";
import type { ToolCall, ToolResult } from "../../tools/types";
import { planSnapshotFromModule, adaptActivePlan } from "../../core/host-plan";
import { WebHost } from "../../cli/web-host";
import { loadAssets } from "./assets";
import { makeForwarder, type Forwarder } from "./forward";
import { startServer, stopServer } from "./server";
import { createWebUiState, type WebUiState } from "./state";

export interface WebUiDeps {
  agent: Agent;
  config: AppConfig;
  sessionManager?: SessionManager;
  execModule?: ExecutionModule;
  /** Bind address override (default: state default / env). */
  host?: string;
  /** Token override (mandatory for a non-loopback bind). */
  token?: string;
}

export interface WebUiHandle {
  state: WebUiState;
  host: Host;
  forwarder: Forwarder;
  url: Promise<string>;
  stop(): void;
}

/** Build the host snapshot from live module state (correction #6). */
export function buildHostState(deps: WebUiDeps, busy: boolean): HostStateSnapshot {
  const meta = deps.sessionManager?.getActiveMeta();
  return {
    busy,
    sessionId: meta?.id,
    sessionName: meta?.name,
    model: deps.config.model,
    provider: deps.config.provider?.active,
    plan: planSnapshotFromModule(adaptActivePlan(deps.execModule?.getActivePlan())),
  };
}

/**
 * Start the browser UI. The state is created first, then the `WebHost`, then the
 * server — so the busy flag is shared end-to-end.
 */
export async function startWebUi(deps: WebUiDeps): Promise<WebUiHandle> {
  const state = createWebUiState();
  if (deps.host) state.host = deps.host;
  if (deps.token) state.token = deps.token;

  const forwarder = makeForwarder(state);

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
  const resultFor = (ev: ToolEvent): ToolResult => ({ success: !ev.error, output: "" });

  // `AgentResult` has no `interrupted` field and `agent.shutdown()` may still
  // return `success: true`, so track the interrupt locally. The REPL interrupts
  // via `agent.shutdown()` (repl.ts `interruptRun`); we match it.
  let interrupted = false;
  let toolCalls = 0;

  const runAgent = async (text: string): Promise<unknown> => {
    interrupted = false;
    toolCalls = 0;
    state.agentRunning = true;
    try {
      const result = await deps.agent.run(
        text,
        (chunk) => forwarder.onText(chunk),
        (meta) => forwarder.onMeta(meta),
        (ev) => {
          if (ev.type === "start") {
            forwarder.onToolStart(callFor(ev, startId(ev.tool)));
          } else {
            toolCalls++;
            forwarder.onToolEnd(callFor(ev, endId(ev.tool)), resultFor(ev), ev.duration ?? 0);
          }
        },
        (phase) => forwarder.onPhase(phase),
      );
      forwarder.onTurnEnd({
        success: result.success,
        durationMs: result.durationMs,
        toolCalls,
        interrupted: interrupted || undefined,
      });
      return result;
    } catch (err) {
      forwarder.onTurnEnd({ success: false, interrupted: interrupted || undefined });
      throw err;
    }
  };

  const host = new WebHost({
    isBusy: () => state.agentRunning,
    runAgent,
    interrupt: () => {
      interrupted = true;
      deps.agent.shutdown();
    },
    // Phase 3: slash-command dispatch through a shared handler map is not wired
    // for web yet. The endpoint exists and is authed; keep this a no-op so the
    // UI only shows its own message on a non-2xx response.
    executeCommand: async () => {},
    getState: () => buildHostState(deps, state.busy),
    addPendingImage: (url) => {
      deps.agent.contextManager?.addPendingImage?.({
        type: "image_url",
        image_url: { url },
      });
    },
  });

  state.bridge = host;
  const url = startServer(loadAssets(), state);

  return {
    state,
    host,
    forwarder,
    url,
    stop: () => {
      forwarder.flushNow();
      stopServer(state);
    },
  };
}
