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
import type { Host } from "../../core/host";
import { CONFIG_FILE, saveConfig as persistConfig } from "../../config/config";
import { buildSetupDisplay } from "../setup/answers";
import { WebHost } from "../../core/web-host";
import { loadAssets } from "./assets";
import { makeWebCommands } from "./commands";
import { makeForwarder, type Forwarder } from "./forward";
import { installOutputForwarding } from "./log-forward";
import { installWebPromptIO, type PromptIORegistry } from "./prompt-io";
import { startServer, stopServer } from "./server";
import { makeModelCache } from "./model-cache";
import { makeRunAgent } from "./run-agent";
import { buildHostState, type WebIndexer } from "./host-state";
import { cancelPendingQuestions } from "./prompt-io";
import {
  broadcast,
  createWebUiState,
  type WebPluginManager,
  type WebSkillsModule,
  type WebUiState,
} from "./state";

// Pure snapshot helpers live in `./host-state`; re-exported so existing
// importers (`webui-usage`, `webui-plan` tests) keep working.
export {
  buildHostState,
  captureUsage,
  planEventFor,
  type HostStateInput,
  type WebIndexer,
} from "./host-state";

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

  // Model list: an explicit source wins; otherwise a background cache that
  // follows the active provider (refreshed on every reconfigure).
  const modelCache = deps.knownModels ? null : makeModelCache(deps.agent, deps.config);
  state.knownModels = deps.knownModels ?? modelCache!.get;
  if (modelCache) void modelCache.refresh();
  state.reconfigure = makeReconfigure(
    state,
    deps.agent,
    modelCache ? () => modelCache.refresh() : undefined,
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

  const runAgent = makeRunAgent({
    agent: deps.agent,
    state,
    forwarder,
    sessionManager: deps.sessionManager,
    execModule: deps.execModule,
    contextWindow: deps.config.contextWindow,
  });

  const host = new WebHost({
    isBusy: () => state.agentRunning,
    runAgent: runAgent.run,
    interrupt: () => runAgent.interrupt(),
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
  // Serve assets fresh from disk so editing `assets/*` needs no server restart.
  state.assetSource = loadAssets;
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
