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
import type { SessionRunner } from "../../core/bootstrap/session-runner";
import type { AppConfig } from "../../config/types";
import type { SessionManager } from "../session/manager";
import type { ExecutionModule } from "../execution/module";
import type { MemoryStore } from "../memory/store";
import type { Host } from "../../core/host";
import { CONFIG_FILE, saveConfig as persistConfig } from "../../config/config";
import { buildSetupDisplay } from "../setup/answers";
import { WebHost } from "../../core/web-host";
import { loadAssets } from "./assets";
import { makeWebCommands } from "./chat/commands";
import { makeReconfigure } from "./settings/reconfigure";
import { installOutputForwarding } from "./log-forward";
import { installWebPromptIO, type PromptIORegistry } from "./session/prompt-io";
import { startServer, stopServer } from "./server";
import { makeModelCache } from "./settings/model-cache";
import { buildHostState, type WebIndexer, type WebLsp } from "./host-state";
import { attachIndexWatcher } from "./index-watcher";
import { cancelPendingQuestions } from "./session/prompt-io";
import {
  activeMoe,
  activeUsage,
  broadcast,
  createWebUiState,
  type WebPluginManager,
  type WebSkillsModule,
  type WebUiState,
} from "./state";
import { pushState } from "./session/session-status";

// Чистые снапшот-хелперы живут в `./host-state`; реэкспорт, чтобы существующие
// импортёры (`webui-usage`, `webui-plan` тесты) не чинить.
export {
  buildHostState,
  captureUsage,
  planEventFor,
  type HostStateInput,
  type WebIndexer,
  type WebLsp,
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
  /** Модуль LSP (диагностика) для вкладки LSP сайдбара. */
  lsp?: WebLsp;
  /**
   * Промис context-probe bootstrap (загруженный контекст LM Studio). Резолвится
   * лениво и светится в сайдбаре; на старте не await'ится, чтобы медленный проб
   * не задерживал бинд сервера.
   */
  contextProbe?: Promise<{ model: string; actual: number } | null>;
  /** Id моделей активного провайдера (дефолт — фоновый кеш). */
  knownModels?: () => string[];
  /**
   * Фабрика per-session раннеров из bootstrap (свой агент/контекст/трекер).
   * Есть — настоящий параллелизм слотов; нет (тесты, старые вызывающие) —
   * legacy single-flight на общем агенте.
   */
  spawnRunner?: (sessionId: string) => SessionRunner;
  /** Оверрайд адреса бинда (дефолт — дефолт состояния / env). */
  host?: string;
  /** Оверрайд токена (обязателен для не-loopback бинда). */
  token?: string;
  /** Virgin-конфиг: гейтить чат за браузерным визардом первого запуска. */
  setupRequired?: boolean;
}

/** Хендл запущенного веб-UI: состояние, хост, URL, стоп. */
export interface WebUiHandle {
  state: WebUiState;
  host: Host;
  url: Promise<string>;
  stop(): void;
}

/**
 * Execution-модуль для сайдбара: живой трекер раннера серверно-активной
 * сессии, если он закеширован (план обновляется прямо по ходу её хода),
 * иначе shared-модуль (слот, поднятый switchSession на activate).
 * Без этого сайдбар показывал бы протухший план бегущей сессии до
 * следующего переключения вкладок.
 */
function activeExecModule(
  state: WebUiState,
  shared: ExecutionModule | undefined,
  sessionId?: string,
): ExecutionModule | undefined {
  try {
    const active =
      sessionId ??
      state.sessionManager?.getActive?.() ??
      state.activeSessionId ??
      null;
    if (active) {
      const runner = state.pool.getRunner(active);
      if (runner) return runner.execModule;
    }
  } catch {
    /* fail-open: shared-модуль */
  }
  return shared;
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
        pushState(state);
      };
    }
  }
  if (deps.lsp) {
    const lsp = deps.lsp;
    state.lspDiagnose = () => lsp.diagnose(deps.baseDir ?? process.cwd());
    state.lspSetEnabled = (v) => lsp.setEnabled?.(v);
    state.lspSetOffline = (v) => lsp.setOffline?.(v);
    state.lspFlags = () => lsp.getFlags?.() ?? { enabled: true, offline: false };
  }
  // Общий вотчер карты: в web сессия главного агента не запускается, поэтому
  // плагин индексатора его не поднимает — владельцем становится веб-хост.
  // Колбэк уведомляет вкладку Files: рост `filesRevision` + событие `files`.
  const detachIndexWatcher = attachIndexWatcher(deps.indexer, () => {
    state.filesRevision += 1;
    broadcast({ type: "files", ts: Date.now(), phase: "changed" }, state);
  });
  state.saveConfig = (config) => persistConfig(config, CONFIG_FILE, deps.configDir);

  // Веб-онли интерактивные тулы: `question`/`approve` через SSE + `/api/answer`.
  installWebPromptIO({
    state,
    agent: deps.agent,
    registry: deps.toolRegistry,
    toolCtx: deps.toolCtx,
  });

  // Параллелизм: спавн per-session раннера + его интерактивный ввод.
  // Реестр-клон уже несёт question/approve из main (install выше), install
  // только ставит exitOnComplete=false и тегирует PromptIO сессией раннера.
  if (deps.spawnRunner) {
    const spawnRunner = deps.spawnRunner;
    state.pool.setFactory((id: string) => {
      const runner = spawnRunner(id);
      installWebPromptIO({
        state,
        agent: runner.agent,
        registry: runner.registry,
        toolCtx: runner.toolCtx,
        sessionId: id,
      });
      // Чип режима в футере: факт «MoE ведёт ход этой сессии». Флаг едет в
      // снапшоте (не отдельным SSE-типом) — по правилу event-sourced state.
      runner.agent.setMoEStateListener((active) => {
        const next = active === true;
        if ((state.moeSessions[id] === true) === next) return;
        state.moeSessions[id] = next;
        pushState(state, id);
      });
      return runner;
    });
  }

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

  // OutputBus → SSE (предупреждения/ошибки процесса). Ходы идут раннерами
  // (см. turns.ts), main-агент в web ходы не обслуживает.
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

  const host = new WebHost({
    isBusy: () => state.pool.anyBusy(),
    // Ходы браузера — только `POST /api/message` → per-session раннер.
    // `Host.submit` (плагинный `hostBridge`) в web не поддерживается.
    runAgent: () => Promise.reject(new Error("web submit: use POST /api/message")),
    // Scoped-стоп раннеров ведёт `actions-api` (по владельцу слота); здесь —
    // no-op fallback для легаси-слота без сессии.
    interrupt: () => {},
    // Слеш-команды идут через shared карту хендлеров; вывод стримится по SSE
    // событиями `command` (HTTP POST лишь подтверждает приём).
    executeCommand: makeWebCommands({ state }),
    getState: (sessionId?: string) =>
      buildHostState(
        {
          config: deps.config,
          sessionManager: deps.sessionManager,
          execModule: activeExecModule(state, deps.execModule, sessionId),
          usage: activeUsage(state, sessionId),
          moeActive: activeMoe(state, sessionId),
          contextProbe: probe,
          workspace: deps.baseDir,
          instructions: deps.agentsMd,
          projectMap: deps.indexer?.mapInfo?.(),
          filesRevision: state.filesRevision,
          sessionId,
        },
        state.busy,
      ),
  });

  state.bridge = host;
  // Ассеты отдаём свежими с диска, чтобы правки `assets/*` не требовали рестарта сервера.
  state.assetSource = loadAssets;
  const url = startServer(loadAssets(), state);

  return {
    state,
    host,
    url,
    stop: () => {
      detachIndexWatcher();
      cancelPendingQuestions(state);
      stopOutputForwarding();
      state.pool.clear();
      stopServer(state);
    },
  };
}
