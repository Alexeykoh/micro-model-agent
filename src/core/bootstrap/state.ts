/**
 * Общее состояние и мелкие хелперы фаз bootstrap.
 *
 * Здесь живёт то, что нужно нескольким фазам сразу: флаг one-shot режима,
 * регистрация встроенных плагинов, таймаут-обёртка, нормализация уровня
 * лога и загрузка AGENTS.md-блоков. Своей логики фаза не несёт — только
 * разделяемые примитивы, чтобы фазы не дублировали их друг у друга.
 */
import { estimateTokens } from "../../llm/token-counter";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Logger, LogLevel } from "../../logger/app-logger";
import type { AgentPlugin } from "../../modules/types";
import type { PromptBlock } from "../types";
import type { AppConfig } from "../../config/types";
import type { ToolRegistry } from "../../tools/index";
import type { PluginManager } from "../../modules/plugins/manager";
import type { SkillsModule } from "../../modules/skills/index";
import type { IndexerModule } from "../../modules/indexer/index";
import type { SessionManager } from "../../modules/session/index";
import type { ContextManager } from "../../modules/context/manager";
import type { ToolContext } from "../../tools/types";
import type { HallucinationDetector } from "../../modules/hallucination/detector";
import type { ModuleRegistry } from "../../modules/registry";
import type { ExecutionModule } from "../../modules/execution/module";
import type { SessionModule } from "../../modules/session/index";
import type { MCPModule } from "../../modules/mcp/index";
import type { MemoryStore } from "../../modules/memory/store";
import type { LspModule } from "../../modules/lsp/module";
import { projectMmaDir } from "../../config/paths";

/** Входные опции bootstrap — 1:1 параметры функции `bootstrap()`. */
export interface BootstrapOptions {
  /** Каталог конфига (по умолчанию глобальный ~/.mma). */
  configDir?: string;
  /** Workspace проекта (по умолчанию process.cwd()). */
  projectDir?: string;
  /** Пропустить загрузку AGENTS.md. */
  noAgentsMd?: boolean;
  /** Остановить агента на первом ответе (one-shot CLI). */
  exitOnComplete?: boolean;
  /** CLI-override режима reasoning. */
  reasoningLevel?: string;
  /** Git-style лог уходящего в LLM контекста. */
  contextLog?: boolean;
}

/**
 * One-shot CLI-подкоманды (`session show`, `usage`, `config` …) рисуют итог и
 * выходят. Фоновый стартовый health-check спавнит дочерний процесс (LSP/tsc),
 * который `process.exit` не пожинает — на Windows сирота держит stdout-пайп, и
 * пайп команды (`mma session show <id> | cat`) виснет. Подкоманды агента не
 * гоняют, поэтому чек там пропускается.
 */
let oneShotMode = false;

/**
 * Включает one-shot режим (пропуск фонового health-check для подкоманд).
 * @param value true — подкоманда без агента.
 */
export function setOneShotMode(value: boolean): void {
  oneShotMode = value;
}

/**
 * Проверяет one-shot режим (нужен фазе модулей для пропуска health-check).
 * @returns true — фоновый стартовый чек пропускается.
 */
export function isOneShotMode(): boolean {
  return oneShotMode;
}

/** Регистрация встроенного плагина модуля: пометка + регистрация. */
export function registerBuiltinPlugin(
  pm: { register(plugin: AgentPlugin): void },
  plugin: AgentPlugin | undefined,
): void {
  if (!plugin) return;
  plugin.isBuiltin = true;
  pm.register(plugin);
}

/** Отклоняет `promise` через `ms`; таймер победителя снимается. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const VALID_LOG_LEVELS: readonly string[] = ["debug", "info", "warn", "error"];

/** Нормализует строку из конфига в LogLevel (без `as any`); неизвестное → info. */
export function normalizeLogLevel(value: string | undefined): LogLevel {
  return value && VALID_LOG_LEVELS.includes(value) ? (value as LogLevel) : "info";
}

/** Кандидаты AGENTS.md по приоритету: проект, проектный `.mma`, глобальный. */
export function agentsMdPaths(baseDir: string, configDir: string): string[] {
  return [
    join(baseDir, "AGENTS.md"),
    join(projectMmaDir(baseDir), "AGENTS.md"),
    join(configDir, "AGENTS.md"),
  ];
}

/**
 * Грузит AGENTS.md из каталога проекта и конфиг-каталога (по приоритету).
 * Каждый найденный непустой файл — prompt-блок высокого приоритета.
 * @param baseDir workspace; @param dir каталог конфига; @param skip пропустить загрузку.
 * @returns блоки инструкций для системного промпта.
 */
export function loadAgentsMdBlocks(
  baseDir: string,
  dir: string,
  skip: boolean,
): PromptBlock[] {
  if (skip) return [];
  const blocks: PromptBlock[] = [];
  const candidates = agentsMdPaths(baseDir, dir);
  for (const p of candidates) {
    if (existsSync(p)) {
      const content = readFileSync(p, "utf-8").trim();
      if (content) {
        blocks.push({
          content,
          priority: "high",
          essential: false,
          estimatedTokens: estimateTokens(content),
          kind: "instructions",
        });
      }
    }
  }
  return blocks;
}

/** Логгер, умеющий только молчаливую запись (для позднего применения пробы). */
export type SilentLogger = Pick<Logger, "logSilent">;

/** Вход фазы модулей — связная группа ранее собранных частей. */
export interface ModulesPhaseInput {
  /** Живой конфиг. */
  config: AppConfig;
  /** Настроенный логгер. */
  logger: Logger;
  /** Каталог конфига. */
  dir: string;
  /** Workspace. */
  baseDir: string;
  /** Пропуск AGENTS.md. */
  noAgentsMd: boolean | undefined;
  /** Флаг выхода на первом ответе (гейтит стартовый health-check). */
  exitOnComplete: boolean | undefined;
  /** Реестр тулов (из фазы workspace). */
  toolRegistry: ToolRegistry;
  /** Менеджер плагинов (из фазы workspace). */
  pluginManager: PluginManager;
  /** Модуль скиллов (динамические промпт-блоки + плагин). */
  skillsModule: SkillsModule;
  /** Индексатор проекта (карта + плагин). */
  indexerModule: IndexerModule;
  /** Менеджер сессий. */
  sessionManager: SessionManager;
  /** Менеджер контекста (onCompact + plan-провайдер). */
  contextManager: ContextManager;
  /** Общий ToolContext (для hidden-tools блока). */
  toolCtx: ToolContext;
  /** Активные теги тулов (для hidden-tools блока). */
  activeToolTags: string[];
  /** Детектор галлюцинаций (в ExecutionModule). */
  hallucinationDetector: HallucinationDetector;
  /** Критичный systemInfo-блок (из фазы workspace). */
  systemInfoPrompt: PromptBlock;
}

/** Итог фазы модулей: реестр, exec-модуль, промпт-блоки и ленивый health-check. */
export interface ModulesPhase {
  /** Реестр модулей (все зарегистрированы). */
  moduleRegistry: ModuleRegistry;
  /** Владелец состояния плана (UI читают активный план отсюда). */
  execModule: ExecutionModule;
  /** Модуль сессий (динамический session-блок). */
  sessionModule: SessionModule;
  /** MCP-модуль (инициализирован или пропущен с варнингом). */
  mcpModule: MCPModule;
  /** Общий стор памяти (один инстанс у модуля и цикла агента). */
  memoryStore: MemoryStore;
  /** Модуль LSP (вкладка LSP в web-сайдбаре, `/lsp doctor`). */
  lspModule: LspModule;
  /** Статичные промпт-блоки первой сборки (system + модули + AGENTS.md + reminder). */
  promptBlocks: PromptBlock[];
  /**
   * Ленивый стартовый health-check: первый вызов ждёт фоновую проверку и
   * кэширует блок; дальше — кэш. Пусто в one-shot/test режимах.
   */
  lazyPromptBlocks: () => Promise<PromptBlock[]>;
  /**
   * Динамические промпт-блоки каждой итерации (скиллы + сессия + карта +
   * скрытые тулы). Отдельной функцией, чтобы Agent звал её каждый ход.
   */
  getDynamicPromptBlocks: () => PromptBlock[];
}
