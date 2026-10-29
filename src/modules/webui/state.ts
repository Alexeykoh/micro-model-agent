// Общее мутабельное состояние модуля `mma web`: сервер, SSE-клиенты, busy-слот,
// коллабораторы bootstrap. Транспортно-ориентировано: меты сессий, планов и
// истории здесь нет.
import type { Server, ServerResponse } from "node:http";
import type { Host } from "../../core/host";
import type { UsageSnapshot } from "../../core/host-state";
import type { AppConfig } from "../../config/types";
import type { PluginLoadFailure, PluginRecord } from "../plugins/records";
import type { SessionMeta, SessionMessage } from "../session/types";
import type { SessionLogEntry } from "../session/store";
import { RunPool } from "./session/session-pool";
import type { MemoryStore } from "../memory/store";
import type { SetupDisplay } from "../setup/answers";
import type { LspDiagnosis } from "../lsp/diagnose";
import { SubagentRunStore } from "./session/subagent-runs";
import { MAX_BODY_BYTES } from "./limits";
import { readEnv } from "../../config/env";

/**
 * Структурное подмножество `SessionManager` для веб-REST. Узкость даёт реальному
 * менеджеру удовлетворять его неявно, а тестам — стабить без кастов. Читалки
 * истории опциональны, чтобы лёгкие стабы только на list/activate/delete
 * оставались валидны; эндпоинт истории без них отвечает пустым транскриптом.
 * Сервер держит явный `WebUiState`, чтобы тесты гонялись герметично на свежем
 * объекте, а не на процесс-глобальном дефолте.
 */
export interface WebSessionManager {
  list(): SessionMeta[];
  get(id: string): SessionMeta | null;
  getActive(): string | null;
  setActive(id: string): void;
  /** Сброс активной сессии (закрытие последней вкладки). Опционален для стабов. */
  clearActive?(): void;
  delete(id: string): void;
  /**
   * Создаёт новую сессию (опционально именованную), возвращает мету. Опционален,
   * чтобы стабы только на list/activate/delete оставались валидны; эндпоинт
   * создания без него отвечает 503.
   */
  create?(name?: string): SessionMeta;
  loadSessionLog?(id: string, opts?: { since?: string }): SessionLogEntry[];
  /** Append a session log record to the active or an explicit session. */
  appendLog?(entry: SessionLogEntry, id?: string): void;
  getHistory?(id: string): SessionMessage[];
  /** Каталог сессии (для персиста web-метрик). Опционален — у лёгких стабов нет. */
  getSessionDirectory?(id: string): string;
}
/** Статические веб-ассеты (снапшот на старт; live-перечитывание — через `assetSource`). */
export interface WebUiAssets {
  html: string;
  css: string;
  /**
   * Альтернативная тема (`/console.css`). Пустая/отсутствует — фронт работает
   * на базовом `styles.css`. Опциональна ради лёгких тестовых фикстур.
   */
  cssConsole?: string;
  js: string;
  /**
   * Скрипт визарда первого запуска (`/setup.js`). Опционален, чтобы лёгкие
   * тестовые фикстуры только под чат оставались валидны.
   */
  setupJs?: string;
  /** Стриминговый Markdown-модуль (`/md.js`). */
  mdJs?: string;
  /** Вендоренный парсер streaming-markdown (`/smd.js`, ESM). */
  smdJs?: string;
  /** Вендоренный бандл highlight.js (`/hljs.js`, кладёт `window.hljs`). */
  hljsJs?: string;
  /**
   * Разделённые фронтенд-модули (`/js/*.js`, относительные импорты из `/app.js`).
   * Опциональны, чтобы лёгкие фикстуры только под чат оставались валидны.
   * Ключи — пути без ведущего слеша (`js/api.js`).
   */
  jsModules?: Record<string, string>;
}

/**
 * Структурные подмножества модулей скиллов/плагинов для REST настроек.
 * Сужение даёт реальным модулям удовлетворять их неявно, а тестам — стабить
 * без кастов (`SkillsModule`/`PluginManager` структурно совместимы).
 */
/** Скилл для REST настроек (имя, описание, путь). */
export interface WebSkillInfo {
  name: string;
  description?: string;
  sourcePath?: string;
}

/** Подмножество модуля скиллов для страницы настроек. */
export interface WebSkillsModule {
  getAvailable(): WebSkillInfo[];
  getLoaded(): WebSkillInfo[];
  /** Пересканировать каталоги навыков (reload); undefined — не умеет. */
  reloadSources?(): { added: number; removed: number };
}

/**
 * Подмножество менеджера плагинов для REST и вкладки Plugins.
 *
 * Раньше здесь жил свой бедный `WebPluginInfo` (имя/версия/источник), а ответ
 * собирался полями вручную — из-за чего `enabled` был захардкожен в `true`.
 * Теперь вид приходит один, из ядра: `PluginManager` удовлетворяет роли
 * структурно, дублировать типы не нужно.
 */
export interface WebPluginManager {
  getRecords(): PluginRecord[];
  getFailures(): PluginLoadFailure[];
  /** Живой тумблер; false — плагина нет (в ответе уже будет 404). */
  setEnabled(name: string, on: boolean): boolean;
  /** Перечитать каталоги с диска (выгрузка + сброс кэша модулей + чтение). */
  reload(): { unloaded: number; loaded: number; failed: number; staleTs: number };
}

/**
 * Метрики usage последнего хода — определены в `core/host-state` вместе с
 * остальной проекцией снапшота (её читает и `mma serve`), здесь реэкспорт.
 */
export type { UsageSnapshot } from "../../core/host-state";

/** Одно входящее сообщение, ждущее конца текущего хода (`POST /api/message` при busy). */
export interface QueuedMessage {
  /** Стабильный id в пуле: адресат отмены/принудительного старта. */
  id: string;
  text: string;
  images: string[];
  /**
   * Сессия-владелец сообщения. Заполняется из `POST /api/message {sessionId}`
   * (фолбэк — тогда-активная); дренаж переключается на неё перед стартом хода,
   * чтобы сообщение из вкладки B не уехало в сессию A (v2, per-session очередь).
   */
  sessionId: string | null;
  /** Когда принято (для сортировки/диагностики; порядок — порядок прихода). */
  ts: number;
}

/** Состояние веб-модуля: сервер, клиенты, мост хоста, коллабораторы REST. */
export interface WebUiState {
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
   * Коллабораторы bootstrap для REST конфига/сессий/моделей. Вяжет `module.ts`;
   * опциональны, чтобы тесты гоняли точки изолированно (отсутствующий даёт 503,
   * никогда — краш).
   */
  config?: AppConfig;
  sessionManager?: WebSessionManager;
  /**
   * Execution-модуль для привязки плана к сессии: смена/создание сессии
   * переключает трекер (`switchSession`), удаление — чистит слот
   * (`forgetSession`). Узкий Pick, чтобы тесты стабились без модуля.
   */
  execModule?: {
    switchSession(id: string | null): void;
    forgetSession(id: string): void;
  };
  saveConfig?: (config: AppConfig, key?: string) => void;
  reconfigure?: (config: AppConfig) => void | Promise<void>;
  knownModels?: () => string[];
  /**
   * Перечитывает статические веб-ассеты с диска на запрос. Вяжет `module.ts`,
   * чтобы правки `assets/*` подхватывались без рестарта `mma web`; тесты могут
   * не ставить и полагаться на фиксированный снапшот из `startServer`.
   */
  assetSource?: () => WebUiAssets;
  /** Рабочий каталог агента (`-d`) для секции «окружение» сайдбара и `/status`. */
  workspace?: string;
  /** Загруженные источники AGENTS.md (проект + глобальный) или `disabled` через `--no-agents-md`. */
  agentsMd?: { files: string[]; disabled: boolean };
  /** Статистика карты проекта (`null`, пока обход индекса не кончился). */
  projectMapStats?: () => { files: number; symbols: number; tokens: number } | null;
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
   * Установка доступного апдейта по кнопке в web (`POST /api/update`).
   * `undefined` — апдейтер в этом режиме не собран (dev или выключен).
   */
  updaterInstall?: () => Promise<{ success: boolean; installed?: string; error?: string }>;
  /** Ручной пересбор индекса карты проекта (`POST /api/index`). */
  refreshIndex?: () => Promise<void>;
  /** Диагностика LSP по требованию (вкладка LSP, `POST /api/lsp/doctor`). */
  lspDiagnose?: () => Promise<LspDiagnosis>;
  /** Структурная диагностика одного файла (`POST /api/lsp/check`); null — модуль не умеет. */
  lspCheckFile?: (relPath: string) => Promise<{ ok: boolean; path: string; diagnostics: unknown[]; truncated?: boolean; ms?: number; error?: string } | null>;
  /** Диагностика изменённых файлов (`POST /api/lsp/check-changed`). */
  lspCheckChanged?: () => Promise<{ ok: boolean; error?: string; files: unknown[]; truncated?: boolean; ms?: number } | null>;
  /** Последний результат диагностики LSP (кэш; `GET /api/lsp/doctor`). */
  lspDoctor?: LspDiagnosis;
  /** LSP-проба идёт прямо сейчас (single-flight). */
  lspProbing?: boolean;
  /** Живой тумблер глобального LSP (`config.lsp.enabled`) для `/api/config`. */
  lspSetEnabled?: (enabled: boolean) => void;
  /** Живой тумблер офлайн-режима (`config.lsp.offline`) для `/api/config`. */
  lspSetOffline?: (offline: boolean) => void;
  /** Текущие флаги LSP-модуля (ответ `GET /api/lsp/doctor`). */
  lspFlags?: () => { enabled: boolean; offline: boolean };
  /**
   * Глобальный стор памяти, общий с агентом (владелец — `bootstrap`).
   * Вяжет `module.ts`; опционален, чтобы тесты гоняли диспатч команд без
   * файловой системы — тогда `/memory` отвечает "unavailable".
   */
  memory?: MemoryStore;
  /**
   * Реестр скиллов из bootstrap (`BootstrapResult.skillsModule`) для страницы
   * настроек "Skills". Отсутствует → `GET /api/skills` отвечает 503.
   */
  skills?: WebSkillsModule;
  /**
   * Менеджер плагинов из bootstrap (`BootstrapResult.pluginManager`) для
   * страницы "Plugins · MCP". Отсутствует → `GET /api/plugins` отвечает 503.
   * MCP-серверы читаются из `config.mcpServers`.
   */
  plugins?: WebPluginManager;
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
 */

/** Роль: SSE-рассылка (буфер клиентов). */
export type SseTransport = Pick<WebUiState, "clients">;

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
  "config" | "saveConfig" | "reconfigure" | "knownModels"
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

/** SSE-событие: тип, время, произвольный пейлоад. */
export interface SseEvent {
  type: string;
  ts: number;
  [k: string]: unknown;
}

/**
 * Шлёт событие SSE-клиентам с backpressure-дропом зависших.
 *
 * Доставляем КАЖДОЕ событие всем клиентам: одно браузерное окно держит
 * несколько вкладок-сессий, и фоновая вкладка должна стримиться живьём, а не
 * молчать до переключения. Раскладка по вкладкам — на клиенте (`feedForEvent`
 * по `sessionId`). Авто-штампа `activeSessionId` нет: сессионные события несут
 * свой `sessionId` явно, глобальные (`state`/`index`) идут без него.
 */
export function broadcast(ev: SseEvent, s: SseTransport): void {
  const payload = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const client of [...s.clients]) {
    // Backpressure: `false` — буфер сокета полон (медленный/виснущий читатель).
    // Дропаем клиента, а не копим события безгранично.
    try {
      if (!client.write(payload)) {
        s.clients.delete(client);
        client.end();
      }
    } catch {
      s.clients.delete(client);
    }
  }
}
