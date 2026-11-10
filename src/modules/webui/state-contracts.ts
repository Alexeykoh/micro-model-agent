// Контракты коллабораторов веб-модуля: статика и структурные подмножества
// модулей скиллов/плагинов. Живут отдельно от `WebUiState`, чтобы описание
// god-state не разрасталось чужими формами; `state.ts` реэкспортирует их,
// поэтому публичная поверхность не меняется.
import type { AppConfig } from "../../config/types";
import type { Logger } from "../../logger/app-logger";
import type { LspDiagnosis } from "../lsp/diagnose";
import type { MemoryStore } from "../memory/store";
import type { PluginLoadFailure, PluginRecord } from "../plugins/records";
import type { WebSessionManager } from "./state-session";

/** Статические веб-ассеты (снапшот на старт; live-перечитывание — через `assetSource`). */
export interface WebUiAssets {
  html: string;
  css: string;
  /**
   * Альтернативная тема (`/console.css`). Пустая/отсутствует — фронт работает
   * на базовом `styles.css`. Опциональна ради лёгких тестовых фикстур.
   */
  cssConsole?: string;
  /**
   * Тема «groovebox» (`/groovebox.css`) — вариация console с акцентной
   * палитрой. Опциональна по той же причине, что и `cssConsole`.
   */
  cssGroovebox?: string;
  /** Тема «Metallica» (`/metallica.css`) — альбомный скин Master of Puppets. */
  cssMetallica?: string;
  /** Обложка-оммаж для фона темы Metallica (`/metallica-cover.svg`). */
  metallicaCover?: string;
  /** Логотип Metallica для хэдера темы (`/metallica-logo.svg`). */
  metallicaLogo?: string;
  /** Пакет дополнительных тем (`/themes.css`): neon/paper/contrast + сезоны. */
  cssThemes?: string;
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
/** Скилл для REST настроек (имя, описание, путь, вид источника). */
export interface WebSkillInfo {
  name: string;
  /** `"builtin"` — из поставки (бейдж в панели); иначе внешний (`global`/`project`). */
  kind?: "builtin" | "global" | "project";
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
 * Коллабораторы bootstrap для REST конфига/сессий/моделей. Вяжет `module.ts`;
 * опциональны, чтобы тесты гоняли точки изолированно (отсутствующий даёт 503,
 * никогда — краш).
 *
 * Вынесено из `WebUiState` отдельным расширяемым контрактом: god-state описывает
 * собственное состояние, а проводка зависимостей — здесь.
 */
export interface WebUiWiring {
  config?: AppConfig;
  /** Логгер для ошибок чтения/настроек, у которых нет активной сессии. */
  logger?: Logger;
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
   * Модели именованной записи провайдера (`GET /api/models?provider=`).
   * Первый запрос к незакешированной записи отвечает `loading: true` и
   * запускает фоновый `listModels()`; клиент перезапрашивает.
   */
  knownModelsFor?: (name: string) => { models: string[]; loading: boolean };
  /**
   * Перечитывает статические веб-ассеты с диска на запрос. Вяжет `module.ts`,
   * чтобы правки `assets/*` подхватывались без рестарта `mma web`; тесты могут
   * не ставить и полагаться на фиксированный снапшот из `startServer`.
   * Фактически отдаёт кешированный снапшот — см. `createAssetSource` (INV-W1).
   */
  assetSource?: () => WebUiAssets;
  /**
   * ETag снапшота ассетов для `If-None-Match` (INV-W1): повторная загрузка
   * страницы отдаёт `304` без тела. `undefined` — без ETag.
   */
  assetEtag?: () => string | undefined;
  /** Рабочий каталог агента (`-d`) для секции «окружение» сайдбара и `/status`. */
  workspace?: string;
  /** Загруженные источники AGENTS.md (проект + глобальный) или `disabled` через `--no-agents-md`. */
  agentsMd?: { files: string[]; disabled: boolean };
  /** Статистика карты проекта (`null`, пока обход индекса не кончился). */
  projectMapStats?: () => { files: number; symbols: number; tokens: number } | null;
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
  lspCheckFile?: (relPath: string) => Promise<{
    ok: boolean;
    path: string;
    diagnostics: unknown[];
    truncated?: boolean;
    ms?: number;
    error?: string;
  } | null>;
  /** Диагностика изменённых файлов (`POST /api/lsp/check-changed`). */
  lspCheckChanged?: () => Promise<{
    ok: boolean;
    error?: string;
    files: unknown[];
    truncated?: boolean;
    ms?: number;
  } | null>;
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
}
