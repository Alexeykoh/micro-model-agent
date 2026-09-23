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
import type { MemoryStore } from "../../modules/memory/store";
import type { Host, HostStateSnapshot } from "../../core/host";
import type { AgentResult, ToolEvent } from "../../core/types";
import type { ToolCall, ToolResult } from "../../tools/types";
import { planSnapshotFromModule, adaptActivePlan } from "../../core/host-plan";
import { CONFIG_FILE, saveConfig as persistConfig } from "../../config/config";
import { WebHost } from "../../core/web-host";
import { loadAssets } from "./assets";
import { makeWebCommands } from "./commands";
import { makeForwarder, type Forwarder } from "./forward";
import { startServer, stopServer } from "./server";
import { broadcast, createWebUiState, type UsageSnapshot, type WebUiState } from "./state";

export interface WebUiDeps {
  agent: Agent;
  config: AppConfig;
  sessionManager?: SessionManager;
  execModule?: ExecutionModule;
  /** Shared global memory store (from bootstrap) backing `/memory` in web mode. */
  memory?: MemoryStore;
  /** Bootstrap config dir — needed so `/api/config` persists to the right place. */
  configDir?: string;
  /** Model ids known to the active provider (defaults to a background cache). */
  knownModels?: () => string[];
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

/**
 * Narrow inputs `buildHostState` reads. Kept separate from {@link WebUiDeps} so
 * the snapshot projection is testable without constructing a full `Agent`.
 * `WebUiDeps` satisfies this structurally.
 */
export interface HostStateInput {
  config: AppConfig;
  sessionManager?: Pick<SessionManager, "getActiveMeta">;
  execModule?: Pick<ExecutionModule, "getActivePlan">;
  usage?: UsageSnapshot;
}

/**
 * Capture the usage-bearing subset of an `AgentResult` into a
 * {@link UsageSnapshot}. Undefined fields are omitted so a partial result never
 * overwrites a previously known value with a blank cell.
 */
export function captureUsage(result: AgentResult, fallbackLimit?: number): UsageSnapshot {
  const usage: UsageSnapshot = {};
  if (typeof result.contextUsed === "number") usage.contextUsed = result.contextUsed;
  const limit = typeof result.contextLimit === "number" ? result.contextLimit : fallbackLimit;
  if (typeof limit === "number") usage.contextLimit = limit;
  if (typeof result.totalCost === "number") usage.costUsd = result.totalCost;
  if (typeof result.compactionCount === "number") usage.compactionCount = result.compactionCount;
  if (result.cache) {
    if (typeof result.cache.hitRate === "number") usage.cacheHitRate = result.cache.hitRate;
    if (typeof result.cache.saved === "number") usage.cacheSaved = result.cache.saved;
  }
  if (typeof result.contextQuality === "number") usage.contextQuality = result.contextQuality;
  return usage;
}

/** Build the host snapshot from live module state (correction #6). */
export function buildHostState(deps: HostStateInput, busy: boolean): HostStateSnapshot {
  const meta = deps.sessionManager?.getActiveMeta();
  return {
    busy,
    sessionId: meta?.id,
    sessionName: meta?.name,
    model: deps.config.model,
    provider: deps.config.provider?.active,
    contextUsed: deps.usage?.contextUsed,
    contextLimit: deps.usage?.contextLimit,
    costUsd: deps.usage?.costUsd,
    compactionCount: deps.usage?.compactionCount,
    cacheHitRate: deps.usage?.cacheHitRate,
    contextQuality: deps.usage?.contextQuality,
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

  // Collaborators for the config/session/model REST surface. `state.config`
  // aliases the live config object, so `/api/config` writes mutate the same
  // object the agent reads after `reconfigure`.
  state.config = deps.config;
  state.sessionManager = deps.sessionManager;
  state.memory = deps.memory;
  state.saveConfig = (config) => persistConfig(config, CONFIG_FILE, deps.configDir);
  state.reconfigure = (config) => deps.agent.reconfigure(config);

  // Model list cache: the endpoint is synchronous, the provider call is not.
  // Refresh once at startup (best-effort) and serve the cache thereafter.
  const modelCache: string[] = [];
  if (deps.knownModels) {
    state.knownModels = deps.knownModels;
  } else {
    state.knownModels = () => modelCache;
    void (async () => {
      try {
        const cfg = deps.config;
        const name =
          cfg.provider.active || cfg.provider.entries?.[0]?.label || cfg.provider.type;
        const provider = deps.agent.getProviderFor(name);
        if (!provider) return;
        const models = await provider.listModels();
        if (models.length > 0) modelCache.splice(0, modelCache.length, ...models.sort());
      } catch {
        // Offline provider: serve an empty list rather than failing startup.
      }
    })();
  }

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
  const resultFor = (ev: ToolEvent): ToolResult => ({
    success: !ev.error,
    output: ev.output ?? "",
  });

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
      // Capture usage before `onTurnEnd` so a `state` broadcast right after the
      // turn already carries the fresh sidebar metrics (the client also polls
      // `/api/state`, so this is an optimization, not the only path).
      state.usage = captureUsage(result, deps.config.contextWindow);
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

  const host = new WebHost({
    isBusy: () => state.agentRunning,
    runAgent,
    interrupt: () => {
      interrupted = true;
      deps.agent.shutdown();
    },
    // Slash commands run through the shared handler map; output streams over
    // SSE as `command` events (the HTTP POST only acknowledges acceptance).
    executeCommand: makeWebCommands({ state }),
    getState: () =>
      buildHostState(
        {
          config: deps.config,
          sessionManager: deps.sessionManager,
          execModule: deps.execModule,
          usage: state.usage,
        },
        state.busy,
      ),
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
