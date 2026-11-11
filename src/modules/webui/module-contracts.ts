// Контракты старта `mma web`: входы модуля и хендл запущенного UI.
// Вынесено из `module.ts` (правило 6): файл модуля — Wiring, этот — типы.
import type { Agent } from "../../core/api";
import type { SessionRunner } from "../../core/bootstrap/session-runner";
import type { AppConfig } from "../../config/types";
import type { SessionManager } from "../session/manager";
import type { ExecutionModule } from "../execution/module";
import type { MemoryStore } from "../memory/store";
import type { Host } from "../../core/host";
import type { WebIndexer, WebLsp } from "./host-state";
import type { WebPluginManager, WebSkillsModule } from "./state";
import type { PromptIORegistry } from "./session/prompt-io";

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
  /** Живой бокс context-probe из bootstrap: web обязан видеть свитч провайдера. */
  contextProbeRef?: { current?: { model: string; actual: number } | null };
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
  logger?: import("../../logger/app-logger").Logger;
}

/** Хендл запущенного веб-UI: состояние, хост, URL, стоп. */
export interface WebUiHandle {
  state: ReturnType<typeof import("./state").createWebUiState>;
  host: Host;
  url: Promise<string>;
  stop(): void;
}
