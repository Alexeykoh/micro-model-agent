// Модуль `mma web`: единственное место, знающее про `Agent`.
// Сервер (`./server`) и форвардер (`./forward`) транспортно-чисты; здесь
// колбэки петли агента вяжутся в SSE-форвардер и отдаются серверу как `Host`.
/**
 * Single-flight: `WebUiState` создаётся ПЕРВЫМ, чтобы busy-предикат `WebHost`
 * и сервер делили ОДИН объект. Сервер ставит `busy = true` синхронно на сабмите;
 * `runAgent` ставит `agentRunning = true` на старте хода; форвардер сбрасывает
 * оба на `turn_end`. Гард хоста смотрит на `agentRunning` (не `busy`), чтобы
 * собственный `submit` владельца не отвергался резервом сервера.
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
import { drainQueueTurn } from "./util";
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

// Чистые снапшот-хелперы живут в `./host-state`; реэкспорт, чтобы существующие
// импортёры (`webui-usage`, `webui-plan` тесты) не чинить.
export {
  buildHostState,
  captureUsage,
  planEventFor,
  type HostStateInput,
  type WebIndexer,
} from "./host-state";

/** Входы старта веб-UI: агент, конфиг, менеджеры, окружение. */
export interface WebUiDeps {
  agent: Agent;
  config: AppConfig;
  sessionManager?: SessionManager;
  execModule?: ExecutionModule;
  /** Shared-глобальный стор памяти (из bootstrap) для `/memory` в вебе. */
  memory?: MemoryStore;
  /** Реестр скиллов (из bootstrap) для страницы настроек "Skills". */
  skills?: WebSkillsModule;
  /** Менеджер плагинов (из bootstrap) для страницы "Plugins · MCP". */
  plugins?: WebPluginManager;
  toolRegistry?: PromptIORegistry;
  toolCtx?: { exitOnComplete?: boolean };
  /** Каталог конфига bootstrap — чтобы `/api/config` писал куда надо. */
  configDir?: string;
  /** Рабочий каталог агента (`-d`) для секции «окружение» сайдбара. */
  baseDir?: string;
  /** Загруженные источники AGENTS.md; `disabled` при `--no-agents-md`. */
  agentsMd?: { files: string[]; disabled: boolean };
  /** Модуль карты проекта (индекс) для статистики сайдбара. */
  indexer?: WebIndexer;
  /**
   * Промис context-probe bootstrap (загруженный контекст LM Studio). Резолвится
   * лениво и светится в сайдбаре; на старте не await'ится, чтобы медленный проб
   * не задерживал бинд сервера.
   */
  contextProbe?: Promise<{ model: string; actual: number } | null>;
  /** Id моделей активного провайдера (дефолт — фоновый кеш). */
  knownModels?: () => string[];
  /** Оверрайд адреса бинда (дефолт — дефолт состояния / env). */
  host?: string;
  /** Оверрайд токена (обязателен для не-loopback бинда). */
  token?: string;
  /** Virgin-конфиг: гейтить чат за браузерным визардом первого запуска. */
  setupRequired?: boolean;
}

/** Хендл запущенного веб-UI: состояние, хост, форвардер, URL, стоп. */
export interface WebUiHandle {
  state: WebUiState;
  host: Host;
  forwarder: Forwarder;
  url: Promise<string>;
  stop(): void;
}

/**
 * Поверхность агента для веб-хука reconfigure. Узкая, чтобы тесты стабили
 * без конструирования настоящего `Agent` (а то потянет всю петлю).
 */
export interface WebReconfigurableAgent {
  reconfigure(config: AppConfig): void | Promise<void>;
  readonly contextManager: { getBudget(): { history: number } };
}

/**
 * Строит вебовый хук `reconfigure`. Он может менять окно/бюджет контекста,
 * и кешнутый лимит сайдбара (история прошлого хода, `budget.history`) протухает.
 * Перечитываем живой бюджет и пушим событие `state`, чтобы браузер обновился
 * сразу, не дожидаясь следующего хода или 2с-полла `/api/state`.
 */
export function makeReconfigure(
  state: WebUiState,
  agent: WebReconfigurableAgent,
  after?: () => Promise<void> | void,
): (config: AppConfig) => Promise<void> {
  return async (config) => {
    await agent.reconfigure(config);
    state.usage = { ...state.usage, contextLimit: agent.contextManager.getBudget().history };
  // Провайдер мог смениться: сначала рефрешим список моделей под провайдера,
  // чтобы follow-up `/api/models` клиента увидел модели нового провайдера.
    if (after) {
      try {
        await after();
      } catch {
        /* результат reconfigure сохраняем, даже если рефреш моделей упал */
      }
    }
    broadcast({ type: "state", ts: Date.now(), busy: state.busy, queueLen: state.pendingQueue.length, usage: state.usage }, state);
  };
}

/**
 * Стартует браузерный UI. Сначала состояние, затем `WebHost`, затем сервер —
 * чтобы флаг busy был общим сквозняком.
 */
export async function startWebUi(deps: WebUiDeps): Promise<WebUiHandle> {
  const state = createWebUiState();
  if (deps.host) state.host = deps.host;
  if (deps.token) state.token = deps.token;
  // Гейтинг первого запуска + данные визарда. `buildSetupDisplay` дёшев и
  // зависит только от пресетов провайдеров, поэтому заполняется всегда.
  state.setupRequired = deps.setupRequired ?? false;
  state.setup = buildSetupDisplay();

  // Коллабораторы REST конфига/сессий/моделей. `state.config` — алиас живого
  // объекта конфига, так что записи `/api/config` мутят тот же объект, что
  // читает агент после `reconfigure`.
  state.config = deps.config;
  state.sessionManager = deps.sessionManager;
  state.execModule = deps.execModule;
  state.memory = deps.memory;
  state.skills = deps.skills;
  state.plugins = deps.plugins;
  state.workspace = deps.baseDir;
  state.agentsMd = deps.agentsMd;
  if (deps.indexer) {
    state.projectMapStats = () => deps.indexer?.stats() ?? null;
    if (deps.indexer.refresh) {
      const refresh = deps.indexer.refresh.bind(deps.indexer);
      state.refreshIndex = async () => {
        broadcast({ type: "index", ts: Date.now(), phase: "start" }, state);
        try {
          await refresh();
        } catch {
          broadcast({ type: "index", ts: Date.now(), phase: "error" }, state);
          throw new Error("index refresh failed");
        }
        const stats = state.projectMapStats?.() ?? null;
        broadcast({ type: "index", ts: Date.now(), phase: "done", stats }, state);
        broadcast({ type: "state", ts: Date.now(), busy: state.busy, queueLen: state.pendingQueue.length, usage: state.usage }, state);
      };
    }
  }
  state.saveConfig = (config) => persistConfig(config, CONFIG_FILE, deps.configDir);

  // Веб-онли интерактивные тулы: `question`/`approve` через SSE + `/api/answer`.
  installWebPromptIO({
    state,
    agent: deps.agent,
    registry: deps.toolRegistry,
    toolCtx: deps.toolCtx,
  });

  // Список моделей: явный источник побеждает; иначе фоновый кеш за активным
  // провайдером (рефреш на каждый reconfigure).
  const modelCache = deps.knownModels ? null : makeModelCache(deps.agent, deps.config);
  state.knownModels = deps.knownModels ?? modelCache!.get;
  if (modelCache) void modelCache.refresh();
  state.reconfigure = makeReconfigure(
    state,
    deps.agent,
    modelCache ? () => modelCache.refresh() : undefined,
  );

  const forwarder = makeForwarder(state, undefined, {
    // Очередь входящих: голова стартует следующим ходом сразу после `turn_end`.
    // `state.bridge` читается в момент вызова (к тому времени уже привязан ниже).
    onQueueDrained: () => drainQueueTurn(state),
  });
  const stopOutputForwarding = installOutputForwarding(state);

  // Context probe: резолвится в фоне; `undefined`, пока не устоялся, чтобы
  // сайдбар рисовал прочерк "pending", не стопая старт.
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
    // Слеш-команды идут через shared карту хендлеров; вывод стримится по SSE
    // событиями `command` (HTTP POST лишь подтверждает приём).
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
          projectMap: deps.indexer?.mapInfo?.(),
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
  // Ассеты отдаём свежими с диска, чтобы правки `assets/*` не требовали рестарта сервера.
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
