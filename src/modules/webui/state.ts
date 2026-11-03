// Общее мутабельное состояние модуля `mma web`: сервер, SSE-клиенты, busy-слот,
// коллабораторы bootstrap. Транспортно-ориентировано: меты сессий, планов и
// истории здесь нет. Контракты коллабораторов и SSE вынесены в `state-*` и
// реэкспортированы ниже — внешние импорты не меняются.
import type { Server, ServerResponse } from "node:http";
import type { Host } from "../../core/host";
import type { UsageSnapshot } from "../../core/host-state";
import { RunPool } from "./session/session-pool";
import type { SetupDisplay } from "../setup/answers";
import { SubagentRunStore } from "./session/subagent-runs";
import { MAX_BODY_BYTES } from "./limits";
import { readEnv } from "../../config/env";
import type { WebUiWiring } from "./state-contracts";

export type { QueuedMessage, WebSessionManager } from "./state-session";
export type {
  WebPluginManager,
  WebSkillInfo,
  WebSkillsModule,
  WebUiAssets,
  WebUiWiring,
} from "./state-contracts";
export { broadcast } from "./state-sse";
export type { SseEvent, SseTransport } from "./state-sse";

/**
 * Метрики usage последнего хода — определены в `core/host-state` вместе с
 * остальной проекцией снапшота (её читает и `mma serve`), здесь реэкспорт.
 */
export type { UsageSnapshot } from "../../core/host-state";

/** Состояние веб-модуля: сервер, клиенты, мост хоста, коллабораторы REST. */
export interface WebUiState extends WebUiWiring {
  server: Server | null;
  starting: Promise<string> | null;
  url: string;
  host: string;
  token: string | null;
  clients: Set<ServerResponse>;
  bridge: Host | null;
  /**
   * Агрегат занятости: true, пока бежит ХОТЬ ОДИН ход (владелец — пул).
   * Per-session busy — в пуле (`pool.isBusy`), бейджи вкладок — из
   * `sessionStatus().runningSessionIds`.
   */
  busy: boolean;
  /**
   * Реально ли выполняется ход агента. Отдельно от {@link busy}, чтобы резерв
   * сервера (до вызова `submit`) НЕ триггерил `isBusy()`-гард `WebHost.submit`.
   */
  agentRunning: boolean;
  /**
   * Per-session пул прогонов: очереди, busy-слоты, кеш раннеров.
   * Настоящий параллелизм — слоты разных сессий бегут одновременно;
   * в пределах сессии — single-flight + FIFO (как раньше глобально).
   */
  pool: RunPool;
  /**
   * Сквозной счётчик завершённых ходов (инкремент — форвардерный `onTurnEnd`).
   * Едет в SSE `turn_end` как `turnSeq`, чтобы Trace привязывал строки к ходу.
   */
  turnSeq: number;
  /** Троттл POST — по сессии (параллельные вкладки не блокируют друг друга). */
  lastPostTs: Map<string, number>;
  minPostIntervalMs: number;
  historyTail: number;
  /** Транспортный кап тела POST; переопределяется в тестах ради 413. */
  maxBodyBytes: number;
  /** Кап SSE-клиентов (env `MMA_WEBUI_MAX_CLIENTS`, дефолт 5); per-state ради тестов. */
  maxClients: number;
  /** Метрики usage последнего завершённого хода (см. {@link UsageSnapshot}). */
  usage?: UsageSnapshot;
  /**
   * Метрики usage по сессиям: последний завершённый ход КАЖДОЙ сессии.
   * Сайдбар показывает метрики серверно-активной сессии (а не глобальный
   * last-turn, одинаковый во всех вкладках). Пишет run-agent по владельцу
   * хода; чистится вместе с удалением сессии.
   */
  sessionUsage: Record<string, UsageSnapshot>;
  /**
   * Id сессии-владельца текущего/последнего хода. Штампуется на каждое
   * SSE-событие, чтобы браузер клал стрим во вкладку исходной сессии,
   * а не в случайно активную.
   */
  activeSessionId?: string;
  /**
   * Монотонный счётчик изменений файлов workspace (инкремент — колбэк вотчера
   * индексатора). Едет в снапшот как `filesRevision`; клиент вкладки Files
   * перечитывает раскрытые папки при росте (фолбэк к SSE `files`).
   */
  filesRevision: number;
  /**
   * Доступный апдейт: текущая и свежая версии. Живёт в снапшоте (а не только в
   * SSE `update`), чтобы чип в футере пережил реконнект и был виден вновь
   * открытой вкладке. `undefined` — апдейта нет либо он уже поставлен.
   */
  updateAvailable?: { current: string; latest: string };
  /**
   * Висящие интерактивные вопросы (`question`/`approve`) по id SSE-`question`.
   * Веб-`PromptIO` регистрирует здесь резолвер, `POST /api/answer` его закрывает;
   * `cancelPendingQuestions` дренирует мапу на interrupt/shutdown.
   */
  pendingQuestions: Map<string, import("./session/prompt-io").PendingQuestion>;
  /**
   * True для virgin-конфига (`runWeb` вычислил `virgin`): сначала браузерный
   * визард, потом чат. Принуждается сервером — `/api/message` и `/api/command`
   * отвечают 409, пока `POST /api/setup` не снимет.
   */
  setupRequired: boolean;
  /** Статика визарда (языки/провайдеры/дефолты) для `GET /api/setup`. */
  setup?: SetupDisplay;
  /**
   * Прогоны субагентов в памяти процесса: ход дочернего агента для вкладки
   * «субагент» (`GET /api/sessions/:id/subagents`). События — SSE `subagent`;
   * раннеры ставят `ToolContext.subagentRuns` на время хода.
   */
  subagentRuns: SubagentRunStore;
}

/**
 * Роли `WebUiState`: доменные модули принимают узкий срез, который реально
 * используют, а не весь god-object. Композиция живёт в `WebUiState`; транспорт
 * и оркестратор (`server.ts`/`util.ts`/`module.ts`) по-прежнему видят её целиком.
 * `SseTransport` — в `state-sse.ts` (там же `broadcast`), реэкспорт выше.
 */

/** Роль: HTTP-транспорт (хост/токен/капы/хвост истории/куки). */
export type HttpTransport = Pick<
  WebUiState,
  | "server"
  | "starting"
  | "url"
  | "host"
  | "token"
  | "maxClients"
  | "maxBodyBytes"
  | "lastPostTs"
  | "minPostIntervalMs"
  | "historyTail"
>;

/** Роль: рантайм хода (busy-флаги, пул, вопросы, мост хоста). */
export type RuntimeState = Pick<
  WebUiState,
  "busy" | "agentRunning" | "pool" | "bridge" | "turnSeq" | "pendingQuestions"
>;

/** Роль: сессии (менеджер, план-трекер, usage). */
export type SessionStore = Pick<
  WebUiState,
  "sessionManager" | "execModule" | "sessionUsage" | "usage" | "activeSessionId" | "subagentRuns"
>;

/** Роль: конфиг (живой объект, запись, reconfigure, список моделей). */
export type ConfigStore = Pick<
  WebUiState,
  "config" | "saveConfig" | "reconfigure" | "knownModels" | "knownModelsFor"
>;

/** Роль: рабочее окружение и настройки (workspace, память, скиллы, плагины, LSP, setup). */
export type WorkspaceStore = Pick<
  WebUiState,
  | "workspace"
  | "agentsMd"
  | "projectMapStats"
  | "refreshIndex"
  | "lspDiagnose"
  | "lspCheckFile"
  | "lspCheckChanged"
  | "lspDoctor"
  | "lspProbing"
  | "lspSetEnabled"
  | "lspSetOffline"
  | "lspFlags"
  | "memory"
  | "skills"
  | "plugins"
  | "setup"
  | "setupRequired"
>;

/** Только положительный int; мусор даёт фолбэк 5. */
export function parseMaxClients(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 5;
}

/** Свежее состояние с env-дефолтами (хост, токен, капы). */
export function createWebUiState(): WebUiState {
  return {
    server: null,
    starting: null,
    url: "",
    host: readEnv("WEBUI_HOST") || "127.0.0.1",
    token: readEnv("WEBUI_TOKEN") || null,
    clients: new Set(),
    bridge: null,
    busy: false,
    agentRunning: false,
    pool: new RunPool(),
    turnSeq: 0,
    lastPostTs: new Map<string, number>(),
    minPostIntervalMs: 500,
    historyTail: 200,
    maxBodyBytes: MAX_BODY_BYTES,
    maxClients: parseMaxClients(readEnv("WEBUI_MAX_CLIENTS")),
    pendingQuestions: new Map(),
    setupRequired: false,
    sessionUsage: {},
    subagentRuns: new SubagentRunStore(),
    filesRevision: 0,
  };
}

export { activeUsage } from "./session/usage-cache";
