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
import type { ExecutionModule } from "../execution/module";
import { CONFIG_FILE, persistConfigChange as persistConfig } from "../../config/persist";
import { buildSetupDisplay } from "../setup/answers";
import { WebHost } from "../../core/web-host";
import { createAssetSource } from "./asset-cache";
import { makeWebCommands } from "./chat/commands";
import { makeReconfigure } from "./settings/reconfigure";
import { installWebForwarding } from "./event-forward";
import { installWebPromptIO } from "./session/prompt-io";
import { startServer, stopServer } from "./server";
import { makeModelCache } from "./settings/model-cache";
import { buildHostState } from "./host-state";
import { attachIndexWatcher } from "./index-watcher";
import { createGitCache, gitPeek } from "./git/snapshot-cache";
import { trackContextProbe, type ProbeValue } from "./context-probe";
import { cancelPendingQuestions } from "./session/prompt-io";
import {
  activeUsage,
  broadcast,
  createWebUiState,
  type WebUiState,
} from "./state";
import { pushState } from "./session/session-status";
import { emitSessions } from "./session/sessions-api";
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

// Контракты старта (`WebUiDeps`/`WebUiHandle`) — в `./module-contracts`
// (правило 6: модуль остаётся Wiring-файлом). Реэкспорт сохраняет публичный
// импорт `from "./module"` для bootstrap и тестов.
export type { WebUiDeps, WebUiHandle } from "./module-contracts";
import type { WebUiDeps, WebUiHandle } from "./module-contracts";

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
      sessionId ?? state.sessionManager?.getActive?.() ?? state.activeSessionId ?? null;
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
  state.logger = deps.logger;
  state.sessionManager = deps.sessionManager;
  state.execModule = deps.execModule;
  // Живое переименование сессии (детерминированное авто-имя и асинхронный
  // LLM-заголовок) доезжает до вкладки и списка без reload: раннер пишет имя
  // через pinned-сиблинг, а слушатель общий с главным менеджером.
  const detachRenameListener = deps.sessionManager?.onRename((meta) => {
    emitSessions(state);
    pushState(state, meta.id);
  });
  state.memory = deps.memory;
  state.skills = deps.skills;
  state.plugins = deps.plugins;
  state.workspace = deps.baseDir;
  state.gitCache = createGitCache();
  // Прогрев: первый снимок собирается до первого запроса клиента, а результат
  // пушится (иначе бейдж под композером ждал бы второго тика состояния).
  if (deps.baseDir) {
    gitPeek(state.gitCache, deps.baseDir, state.filesRevision, () => pushState(state));
  }
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
    const base = deps.baseDir ?? process.cwd();
    state.lspDiagnose = () => lsp.diagnose(base);
    state.lspCheckFile = (rel) => lsp.checkFileForWeb?.(rel, base) ?? Promise.resolve(null);
    state.lspCheckChanged = () => lsp.checkChangedForWeb?.(base) ?? Promise.resolve(null);
    state.lspSetEnabled = (v) => lsp.setEnabled?.(v);
    state.lspSetOffline = (v) => lsp.setOffline?.(v);
    state.lspFlags = () => lsp.getFlags?.() ?? { enabled: true, offline: false };
  }
  // Общий вотчер карты: в web сессия главного агента не запускается, поэтому
  // плагин индексатора его не поднимает — владельцем становится веб-хост.
  // Колбэк уведомляет Files (`filesRevision` + `files`) и пушит state (B-40).
  const detachIndexWatcher = attachIndexWatcher(deps.indexer, () => {
    state.filesRevision += 1;
    // Рост rev — сигнал git-кешу пересобраться; снимок добирается фоном,
    // и по готовности пушим state, чтобы чипы обновились без reload.
    if (state.gitCache && deps.baseDir) {
      gitPeek(state.gitCache, deps.baseDir, state.filesRevision, () => pushState(state));
    }
    broadcast({ type: "files", ts: Date.now(), phase: "changed" }, state);
    pushState(state);
  });
  state.saveConfig = (config, key) => persistConfig(config, key, CONFIG_FILE, deps.configDir);

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
      return runner;
    });
  }

  // Список моделей: явный источник побеждает; иначе фоновый кеш (рефреш на reconfigure).
  const modelCache = deps.knownModels ? null : makeModelCache(deps.agent, deps.config);
  state.knownModels = deps.knownModels ?? modelCache!.get;
  state.knownModelsFor = modelCache?.getFor;
  if (modelCache) void modelCache.refresh();
  state.reconfigure = makeReconfigure(
    state,
    deps.agent,
    modelCache ? () => modelCache.refresh() : undefined,
  );

  // Глобальные шины → SSE: лог/предупреждения, снимок запроса (U20), журнал
  // защиты (U22). Ходы идут раннерами (см. turns.ts), main-агент их не ведёт.
  const stopForwarding = installWebForwarding(state);

  // Context probe: резолвится в фоне; `undefined`, пока не устоялся, чтобы
  // сайдбар рисовал прочерк "pending", не стопая старт.
  let probe: ProbeValue | null | undefined;
  trackContextProbe(deps.contextProbe, (p) => {
    probe = p;
  });

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
          updateAvailable: state.updateAvailable,
          contextProbe: probe,
          workspace: deps.baseDir,
          instructions: deps.agentsMd,
          projectMap: deps.indexer?.mapInfo?.(),
          filesRevision: state.filesRevision,
          git: state.gitCache && deps.baseDir
            ? gitPeek(state.gitCache, deps.baseDir, state.filesRevision, () => pushState(state))
            : null,
          sessionId,
        },
        state.busy,
      ),
  });

  state.bridge = host;
  // Снапшот ассетов вместо пересборки на каждый запрос (INV-W1): правки
  // `assets/*` цепляются по отпечатку дерева, рестарт не нужен.
  const assets = createAssetSource();
  state.assetSource = assets.get;
  state.assetEtag = assets.etag;
  const url = startServer(assets.get(), state);

  return {
    state,
    host,
    url,
    stop: () => {
      detachIndexWatcher();
      detachRenameListener?.();
      cancelPendingQuestions(state);
      stopForwarding();
      state.pool.clear();
      stopServer(state);
    },
  };
}
