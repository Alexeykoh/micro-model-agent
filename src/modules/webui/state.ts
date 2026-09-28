// Общее мутабельное состояние модуля `mma web`: сервер, SSE-клиенты, busy-слот,
// коллабораторы bootstrap. Транспортно-ориентировано: меты сессий, планов и
// истории здесь нет.
import type { Server, ServerResponse } from "node:http";
import type { Host } from "../../core/host";
import type { AppConfig } from "../../config/types";
import type { SessionMeta, SessionMessage } from "../../modules/session/types";
import type { SessionLogEntry } from "../../modules/session/store";
import type { MemoryStore } from "../memory/store";
import type { SetupDisplay } from "../setup/answers";
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
  delete(id: string): void;
  /**
   * Создаёт новую сессию (опционально именованную), возвращает мету. Опционален,
   * чтобы стабы только на list/activate/delete оставались валидны; эндпоинт
   * создания без него отвечает 503.
   */
  create?(name?: string): SessionMeta;
  loadSessionLog?(id: string): SessionLogEntry[];
  getHistory?(id: string): SessionMessage[];
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
   * Single-flight резерв UI (`/api/message`). Владелец — сервер: ставится
   * синхронно при принятом сабмите, сбрасывается форвардерным `turn_end`
   * (или {@link releaseBusy}, если ход так и не стартовал).
   */
  busy: boolean;
  /**
   * Реально ли выполняется ход агента. Отдельно от {@link busy}, чтобы резерв
   * сервера (ставится до вызова `submit`) НЕ триггерил собственный `isBusy()`-гард
   * `WebHost.submit`. Ставится на старте `runAgent`, сбрасывается форвардерным
   * `turn_end`.
   */
  agentRunning: boolean;
  /** Токен владения {@link busy}; см. {@link reserveBusy}/{@link releaseBusy}. */
  turnToken: object | null;
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
  pendingQuestions: Map<string, (value: unknown) => void>;
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
    bridge: null,
    busy: false,
    agentRunning: false,
    turnToken: null,
    lastPostTs: 0,
    minPostIntervalMs: 500,
    historyTail: 200,
    maxBodyBytes: MAX_BODY_BYTES,
    maxClients: parseMaxClients(readEnv("WEBUI_MAX_CLIENTS")),
    pendingQuestions: new Map(),
    setupRequired: false,
  };
}

/** SSE-событие: тип, время, произвольный пейлоад. */
export interface SseEvent {
  type: string;
  ts: number;
  [k: string]: unknown;
}

/** Шлёт событие всем SSE-клиентам (с backpressure-дропом зависших). */
export function broadcast(ev: SseEvent, s: WebUiState): void {
  // Штампуем активную сессию на каждое событие, чтобы клиент клал стрим
  // в правильную вкладку. Событие вправе переопределить явно.
  const data: SseEvent = s.activeSessionId ? { sessionId: s.activeSessionId, ...ev } : ev;
  const payload = `event: ${ev.type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of s.clients) {
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

/**
 * Атомарно резервирует single-flight слот, возвращает токен владения.
 *
 * Звать СИНХРОННО в том же тике, что пречек busy: любой `await` между чеком
 * и резервом даст двум конкурентным сабмитам оба выиграть. Токен явно фиксирует
 * владельца сброса — поздний колбэк провала прошлого хода чужой резерв не снесёт.
 */
export function reserveBusy(s: WebUiState): object {
  const token = {};
  s.turnToken = token;
  s.busy = true;
  return token;
}

/**
 * Отпускает слот, только если `token` всё ещё владеет им. Возвращает, был ли
 * вызывающий владельцем (чтобы скипнуть дублирующий бродкаст `state`, когда
 * форвардерный `turn_end` флаг уже сбросил).
 */
export function releaseBusy(s: WebUiState, token: object): boolean {
  if (s.turnToken !== token) return false;
  s.turnToken = null;
  s.busy = false;
  return true;
}
