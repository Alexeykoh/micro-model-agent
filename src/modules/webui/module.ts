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
import { buildSetupDisplay } from "../setup/answers";
import { WebHost } from "../../core/web-host";
import { loadAssets } from "./assets";
import { makeWebCommands } from "./commands";
import { makeForwarder, type Forwarder } from "./forward";
import { installOutputForwarding } from "./log-forward";
import { cancelPendingQuestions, installWebPromptIO, type PromptIORegistry } from "./prompt-io";
import { startServer, stopServer } from "./server";
import {
  broadcast,
  createWebUiState,
  type UsageSnapshot,
  type WebPluginManager,
  type WebSkillsModule,
  type WebUiState,
} from "./state";

export interface WebUiDeps {
  agent: Agent;
  config: AppConfig;
  sessionManager?: SessionManager;
  execModule?: ExecutionModule;
  /** Shared global memory store (from bootstrap) backing `/memory` in web mode. */
  memory?: MemoryStore;
  /** Skills registry (from bootstrap) backing the settings "Skills" page. */
  skills?: WebSkillsModule;
  /** Plugin manager (from bootstrap) backing the settings "Plugins · MCP" page. */
  plugins?: WebPluginManager;
  toolRegistry?: PromptIORegistry;
  toolCtx?: { exitOnComplete?: boolean };
  /** Bootstrap config dir — needed so `/api/config` persists to the right place. */
  configDir?: string;
  /** Agent workspace (`-d` dir) surfaced in the sidebar "environment" section. */
  baseDir?: string;
  /** Loaded AGENTS.md sources; `disabled` when `--no-agents-md`. */
  agentsMd?: { files: string[]; disabled: boolean };
  /** Project-map (index) module for sidebar stats. */
  indexer?: WebIndexer;
  /**
   * Bootstrap context-probe promise (LM Studio loaded context). Resolved lazily
   * and surfaced in the sidebar; never awaited at startup so a slow probe can't
   * delay the server bind.
   */
  contextProbe?: Promise<{ model: string; actual: number } | null>;
  /** Model ids known to the active provider (defaults to a background cache). */
  knownModels?: () => string[];
  /** Bind address override (default: state default / env). */
  host?: string;
  /** Token override (mandatory for a non-loopback bind). */
  token?: string;
  /** Virgin config: gate chat behind the browser first-run wizard. */
  setupRequired?: boolean;
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
  contextProbe?: { model: string; actual: number } | null;
  workspace?: string;
  instructions?: { files: string[]; disabled: boolean };
  projectMap?: { indexed: boolean; files: number; symbols: number; tokens: number } | null;
}

/** Structural subset of the indexer module the sidebar needs (avoids a hard dep). */
export interface WebIndexer {
  buildIndex(): Promise<unknown>;
  stats(): { files: number; symbols: number; tokens: number } | null;
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

/**
 * Agent surface the web reconfigure hook needs. Narrow so tests can stub it
 * without constructing a real `Agent` (which would drag in the whole loop).
 */
export interface WebReconfigurableAgent {
  reconfigure(config: AppConfig): void | Promise<void>;
  readonly contextManager: { getBudget(): { history: number } };
}

/**
 * Build the web-owned `reconfigure` hook. `reconfigure` may resize the context
 * window/budget, so the cached sidebar limit (the previous turn's
 * `budget.history`) goes stale. Re-read the live budget and push a `state`
 * event so the browser updates immediately, without waiting for the next turn
 * or the 2s `/api/state` poll.
 */
export function makeReconfigure(
  state: WebUiState,
  agent: WebReconfigurableAgent,
  after?: () => Promise<void> | void,
): (config: AppConfig) => Promise<void> {
  return async (config) => {
    await agent.reconfigure(config);
    state.usage = { ...state.usage, contextLimit: agent.contextManager.getBudget().history };
    // Provider may have changed: refresh the per-provider model list first so the
    // client's follow-up `/api/models` sees the new provider's models.
    if (after) {
      try {
        await after();
      } catch {
        /* keep the reconfigure result even if the model refresh fails */
      }
    }
    broadcast({ type: "state", ts: Date.now(), busy: state.busy, usage: state.usage }, state);
  };
}

/**
 * Resolve the plan snapshot to broadcast after a tool ends. Only `plan`/`todo`
 * tools mutate the active plan, so any other tool yields `null` (no event).
 * Pure so the hook is testable without booting the agent/server.
 */
export function planEventFor(
  toolName: string,
  execModule?: Pick<ExecutionModule, "getActivePlan">,
): HostStateSnapshot["plan"] | null {
  if (toolName !== "plan" && toolName !== "todo") return null;
  return planSnapshotFromModule(adaptActivePlan(execModule?.getActivePlan()));
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
    contextProbe: deps.contextProbe,
    workspace: deps.workspace,
    instructions: deps.instructions,
    projectMap: deps.projectMap ?? undefined,
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
  // First-run gating + wizard display data. `buildSetupDisplay` is cheap and
  // depends only on the provider presets, so it is always populated.
  state.setupRequired = deps.setupRequired ?? false;
  state.setup = buildSetupDisplay();

  // Collaborators for the config/session/model REST surface. `state.config`
  // aliases the live config object, so `/api/config` writes mutate the same
  // object the agent reads after `reconfigure`.
  state.config = deps.config;
  state.sessionManager = deps.sessionManager;
  state.memory = deps.memory;
  state.skills = deps.skills;
  state.plugins = deps.plugins;
  state.workspace = deps.baseDir;
  state.agentsMd = deps.agentsMd;
  if (deps.indexer) state.projectMapStats = () => deps.indexer?.stats() ?? null;
  state.saveConfig = (config) => persistConfig(config, CONFIG_FILE, deps.configDir);

  // Web-only interactive tools: `question`/`approve` run over SSE + `/api/answer`.
  installWebPromptIO({
    state,
    agent: deps.agent,
    registry: deps.toolRegistry,
    toolCtx: deps.toolCtx,
  });

  // Model list cache: the endpoint is synchronous, the provider call is not.
  // Refresh once at startup (best-effort) and again on every reconfigure so the
  // list follows the active provider instead of going stale.
  const modelCache: string[] = [];
  const refreshModels = async (): Promise<void> => {
    try {
      const cfg = deps.config;
      const name = cfg.provider.active || cfg.provider.entries?.[0]?.label || cfg.provider.type;
      const provider = deps.agent.getProviderFor(name);
      if (!provider) return;
      const models = await provider.listModels();
      modelCache.splice(0, modelCache.length, ...models.slice().sort());
    } catch {
      // Offline provider: keep the previous list rather than failing.
    }
  };
  if (deps.knownModels) {
    state.knownModels = deps.knownModels;
  } else {
    state.knownModels = () => modelCache;
    void refreshModels();
  }
  state.reconfigure = makeReconfigure(
    state,
    deps.agent,
    deps.knownModels ? undefined : refreshModels,
  );

  const forwarder = makeForwarder(state);
  const stopOutputForwarding = installOutputForwarding(state);

  // Context probe: resolve in the background; `undefined` until it settles so
  // the sidebar can render a "pending" dash without blocking startup.
  let probe: { model: string; actual: number } | null | undefined;
  if (deps.contextProbe) {
    void deps.contextProbe
      .then((p) => {
        probe = p;
      })
      .catch(() => {
        probe = null;
      });
  }

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
    // Own every event of this turn for the session that started it, so SSE
    // output routes to the right browser tab even if the user switches tabs.
    state.activeSessionId = deps.sessionManager?.getActiveMeta()?.id;
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
            // A finished `plan`/`todo` tool refreshes the feed's plan card; the
            // sidebar keeps its own `/api/state` projection.
            const plan = planEventFor(ev.tool, deps.execModule);
            if (plan) forwarder.onPlan(plan);
          }
        },
        (phase) => forwarder.onPhase(phase),
        (reasoning) => forwarder.onReasoning(reasoning),
        (critic) => forwarder.onCritic(critic),
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
      // Unblock any tool waiting on a browser answer before the turn unwinds.
      cancelPendingQuestions(state);
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
          contextProbe: probe,
          workspace: deps.baseDir,
          instructions: deps.agentsMd,
          projectMap: (() => {
            const s = deps.indexer?.stats();
            return s ? { indexed: true, ...s } : { indexed: false, files: 0, symbols: 0, tokens: 0 };
          })(),
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
      cancelPendingQuestions(state);
      forwarder.flushNow();
      stopOutputForwarding();
      stopServer(state);
    },
  };
}
