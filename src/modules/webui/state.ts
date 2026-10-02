// Общее мутабельное состояние модуля `mma web`: сервер, SSE-клиенты, busy-слот,
// коллабораторы bootstrap. Транспортно-ориентировано: меты сессий, планов и
// истории здесь нет.
import type { Server, ServerResponse } from "node:http";
import type { Host } from "../../core/host";
import type { ContextBreakdown } from "../../core/types";
import type { AppConfig } from "../../config/types";
import type { SessionMeta, SessionMessage } from "../../modules/session/types";
import type { SessionLogEntry } from "../../modules/session/store";
import { RunPool } from "./session-pool";
import type { MemoryStore } from "../memory/store";
import type { SetupDisplay } from "../setup/answers";
import type { LspDiagnosis } from "../lsp/diagnose";
import { MAX_BODY_BYTES } from "./limits";
import { readEnv } from "../../config/env";
import { loadSessionUsage } from "./session-usage";

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
  delete(id: string): void;
  /**
   * Создаёт новую сессию (опционально именованную), возвращает мету. Опционален,
   * чтобы стабы только на list/activate/delete оставались валидны; эндпоинт
   * создания без него отвечает 503.
   */
  create?(name?: string): SessionMeta;
  loadSessionLog?(id: string): SessionLogEntry[];
  getHistory?(id: string): SessionMessage[];
  /** Каталог сессии (для персиста web-метрик). Опционален — у лёгких стабов нет. */
  getSessionDirectory?(id: string): string;
}

/** Статические веб-ассеты (снапшот на старт; live-перечитывание — через `assetSource`). */
export interface WebUiAssets {
  html: string;
  css: string;
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
}

/** Плагин для REST настроек (имя, версия, источник). */
export interface WebPluginInfo {
  name: string;
  version?: string;
  isBuiltin?: boolean;
  source?: string;
}

/** Подмножество менеджера плагинов для страницы настроек. */
export interface WebPluginManager {
  getPluginInfos(): Array<{ plugin: WebPluginInfo; source?: string }>;
}

/**
 * Метрики usage последнего хода из `AgentResult` для `HostStateSnapshot`.
 * Все поля опциональны: ход без значения оставляет ячейку сайдбара на `—`.
 */
export interface UsageSnapshot {
  contextUsed?: number;
  contextLimit?: number;
  costUsd?: number;
  compactionCount?: number;
  cacheHitRate?: number;
  cacheSaved?: number;
  contextQuality?: number;
  contextBreakdown?: ContextBreakdown;
}

/** Одно входящее сообщение, ждущее конца текущего хода (`POST /api/message` при busy). */
export interface QueuedMessage {
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
  /**
   * Сессия, на которую подписан каждый SSE-клиент (`GET /events?session=`).
   * Событие с `sessionId` доставляется только подписчикам этой сессии; клиенты
   * без подписки (тесты/legacy) получают всё. Глобальные события (без
   * `sessionId`) — всем.
   */
  clientSessions: Map<ServerResponse, string>;
  bridge: Host | null;
  /**
   * Агрегат занятости: true, пока бежит ХОТЬ ОДИН ход (владелец — пул:
   * ставится на резерве слота, сбрасывается форвардерным `turn_end` через
   * пересчёт, или {@link releaseBusy}, если ход так и не стартовал).
   * Per-session busy — в пуле (`pool.isBusy`), бейджи вкладок — из
   * `sessionStatus().runningSessionIds`.
   */
  busy: boolean;
  /**
   * Реально ли выполняется ход агента. Отдельно от {@link busy}, чтобы резерв
   * сервера (ставится до вызова `submit`) НЕ триггерил собственный `isBusy()`-гард
   * `WebHost.submit`. Ставится на старте `runAgent`, сбрасывается форвардерным
   * `turn_end`.
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
   * Едет в SSE `turn_end` как `turnSeq`, чтобы Trace привязывал строки к ходу
   * серверным номером, а не клиентским счётчиком (реконнекты его не сбивают).
   */
  turnSeq: number;
  lastPostTs: number;
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
  saveConfig?: (config: AppConfig) => void;
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
  /** Ручной пересбор индекса карты проекта (`POST /api/index`). */
  refreshIndex?: () => Promise<void>;
  /** Диагностика LSP по требованию (вкладка LSP, `POST /api/lsp/doctor`). */
  lspDiagnose?: () => Promise<LspDiagnosis>;
  /** Последний результат диагностики LSP (кэш; `GET /api/lsp/doctor`). */
  lspDoctor?: LspDiagnosis;
  /** LSP-проба идёт прямо сейчас (single-flight). */
  lspProbing?: boolean;
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
   * `cancelPendingQuestions` дренирует мапу на interrupt/shutdown, чтобы
   * заблокированный тул не вешал ход.
   */
  pendingQuestions: Map<string, import("./prompt-io").PendingQuestion>;
  /**
   * True для virgin-конфига (`runWeb` вычислил `virgin`): сначала браузерный
   * визард, потом чат. Принуждается сервером — `/api/message` и `/api/command`
   * отвечают 409, пока `POST /api/setup` не снимет.
   */
  setupRequired: boolean;
  /** Статика визарда (языки/провайдеры/дефолты) для `GET /api/setup`. */
  setup?: SetupDisplay;
}

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
    clientSessions: new Map(),
    bridge: null,
    busy: false,
    agentRunning: false,
    pool: new RunPool(),
    turnSeq: 0,
    lastPostTs: 0,
    minPostIntervalMs: 500,
    historyTail: 200,
    maxBodyBytes: MAX_BODY_BYTES,
    maxClients: parseMaxClients(readEnv("WEBUI_MAX_CLIENTS")),
    pendingQuestions: new Map(),
    setupRequired: false,
    sessionUsage: {},
  };
}

/**
 * Usage для сайдбара: метрики серверно-активной сессии (или явной `sessionId`
 * веб-вкладки). У сессии без ходов — undefined (сайдбар показывает прочерки),
 * а НЕ чужой last-turn: иначе новая вкладка открывается с цифрами прошлого
 * чата. Снимок лениво поднимается с диска после reload.
 */
export function activeUsage(s: WebUiState, sessionId?: string): UsageSnapshot | undefined {
  try {
    const active =
      sessionId ??
      s.sessionManager?.getActive?.() ??
      s.activeSessionId ??
      null;
    if (active) {
      if (s.sessionUsage[active]) return s.sessionUsage[active];
      // Reload/restart: in-memory карта пуста — поднимаем снимок с диска
      // (каталог сессии) и кэшируем, чтобы не читать файл на каждый полл.
      const dir = s.sessionManager?.getSessionDirectory?.(active);
      if (dir) {
        const persisted = loadSessionUsage(dir);
        if (persisted) {
          s.sessionUsage[active] = persisted;
          return persisted;
        }
      }
    }
  } catch {
    /* fail-open: нет метрик */
  }
  return undefined;
}

/** SSE-событие: тип, время, произвольный пейлоад. */
export interface SseEvent {
  type: string;
  ts: number;
  [k: string]: unknown;
}

/**
 * Шлёт событие SSE-клиентам с backpressure-дропом зависших.
 *
 * Сессионная маршрутизация: событие с `sessionId` уходит только клиентам,
 * подписанным на эту сессию (`clientSessions`); клиенты без подписки получают
 * всё (тесты/legacy). Глобальные события (без `sessionId`) — всем. Авто-штампа
 * `activeSessionId` больше нет: продюсеры сессионных событий помечают их явно,
 * иначе глобальный `state`/`index` ошибочно считался бы чужим для подписчика.
 */
export function broadcast(ev: SseEvent, s: WebUiState): void {
  const payload = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
  const sid = typeof ev.sessionId === "string" ? ev.sessionId : null;
  for (const client of [...s.clients]) {
    if (sid) {
      const sub = s.clientSessions.get(client);
      if (sub !== undefined && sub !== sid) continue;
    }
    // Backpressure: `false` — буфер сокета полон (медленный/виснущий читатель).
    // Дропаем клиента, а не копим события безгранично.
    try {
      if (!client.write(payload)) {
        s.clients.delete(client);
        s.clientSessions.delete(client);
        client.end();
      }
    } catch {
      s.clients.delete(client);
      s.clientSessions.delete(client);
    }
  }
}
