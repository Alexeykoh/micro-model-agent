/**
 * Фаза 3 bootstrap: workspace, окружение, индекс проекта, скиллы и тулы.
 *
 * Порядок 1:1 с исходником: резолв baseDir (громкий фол на несуществующем
 * `-d`) → отчёт окружения → построение индекса проекта → загрузка скиллов →
 * реестр тулов → менеджер плагинов → системный systemInfo-блок.
 */
import { join, resolve } from "path";
import { statSync } from "fs";
import { buildSystemInfo } from "../system-prompt";
import { collectEnvironment, logEnvironment } from "../environment";
import type { EnvironmentReport } from "../environment";
import { IndexerModule } from "../../modules/indexer/index";
import { SkillsLoader, SkillsModule } from "../../modules/skills/index";
import { ToolRegistry, registerAllTools } from "../../tools/index";
import { PluginManager } from "../../modules/plugins/manager";
import { createDraftHost, pendingDrafts, type DraftHostWithLoad } from "../../modules/plugins/draft-host";
import { setPluginGateApplier } from "../../config/registry";
import { estimateTokens } from "../../llm/token-counter";
import type { UserProfile } from "../../modules/user-profile/profile";
import { t } from "../../i18n/index";
import { homedir } from "os";
import type { AppConfig } from "../../config/types";
import type { Logger } from "../../logger/app-logger";
import type { PromptBlock } from "../types";
import { projectMmaDir } from "../../config/paths";

/**
 * Резолвит workspace агента. Несуществующий `-d` (классика: шелл режет по
 * пробелам, висячий бэкслэш экранирует кавычку) должен упасть ГРОМКО здесь —
 * иначе агент молча работает не в том каталоге и уверяет, что всё хорошо.
 */
export function resolveBaseDir(projectDir?: string): string {
  if (!projectDir) return process.cwd();
  const abs = resolve(projectDir);
  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new Error(
      `workspace directory does not exist: ${abs} (received ${JSON.stringify(projectDir)} — ` +
        `if the path contains spaces, quote it without a trailing backslash)`,
    );
  }
  return abs;
}

/** Итог фазы workspace: каталог, окружение, индекс, скиллы, тулы, system-блок. */
export interface WorkspacePhase {
  /** Резолвнутый workspace. */
  baseDir: string;
  /** Отчёт окружения (уже залогирован + варнинги выведены). */
  envReport: EnvironmentReport;
  /** Индексатор карты проекта (индекс уже построен). */
  indexerModule: IndexerModule;
  /** Модуль скиллов с бюджетом из конфига. */
  skillsModule: SkillsModule;
  /** Реестр тулов (все тулы зарегистрированы). */
  toolRegistry: ToolRegistry;
  /** Пустой менеджер плагинов (наполнение — в фазе модулей). */
  pluginManager: PluginManager;
  /**
   * Хост черновиков capabilities (`define_capability`). Одобренные черновики
   * проекта уже загружены, неодобренные — инертны (см. `modules/plugins/drafts.ts`).
   */
  draftHost: DraftHostWithLoad;
  /** Критичный systemInfo-блок для системного промпта. */
  systemInfoPrompt: PromptBlock;
}

/**
 * Готовит workspace, окружение, индекс, скиллы и реестр тулов.
 * @param config живой конфиг; @param logger настроенный логгер;
 * @param dir каталог конфига; @param projectDir запрошенный workspace (опционально);
 * @param profile загруженный профиль пользователя (из фазы провайдера).
 * @returns каталог, отчёт окружения, индекс, скиллы, реестр, system-блок.
 */
export async function setupWorkspacePhase(
  config: AppConfig,
  logger: Logger,
  dir: string,
  projectDir: string | undefined,
  profile: UserProfile,
): Promise<WorkspacePhase> {
  const baseDir = resolveBaseDir(projectDir);

  // Кросс-девайс диагностика: полный отчёт окружения (ОС, рантайм, engines,
  // PATH-тулы, провайдер/ретраи, playwright) на каждый старт.
  const envReport = collectEnvironment({
    configDir: dir,
    baseDir,
    config,
    scanTools: process.env.NODE_ENV !== "test",
  });
  logEnvironment(envReport, logger);
  for (const warning of envReport.warnings) {
    logger.warn(warning);
  }

  const projectMapCacheDir = projectMmaDir(baseDir);
  const indexerModule = new IndexerModule({
    baseDir,
    cacheDir: projectMapCacheDir,
    maxFiles: config.indexer?.maxFiles,
    respectGitignore: config.indexer?.respectGitignore,
    mapTokenBudget: config.indexer?.mapTokenBudget,
  });
  try {
    // Строим (или грузим из кэша) индекс проекта. На большом workspace первый
    // обход подвисает старт без вывода — анонсируем оба конца, чтобы тишина
    // была объяснена.
    logger.info(t("env.indexing"));
    const index = await indexerModule.buildIndex();
    if (index) {
      logger.info(t("env.indexed", { files: String(index.files.length) }));
    } else {
      logger.warn(t("env.indexing_failed", { error: "no index produced" }));
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(t("env.indexing_failed", { error: msg }));
  }

  const skillsLoader = new SkillsLoader();
  const builtinDir = join(import.meta.dirname, "skills", "builtin");
  const globalDir = join(homedir(), ".agents", "skills");
  const projectSkillsDir = join(projectMmaDir(baseDir), "skills");
  const availableSkills = skillsLoader.loadFromAllSources(builtinDir, globalDir, projectSkillsDir);

  const skillsBudget = Math.floor(config.contextWindow * config.skills.budget);
  const skillsModule = new SkillsModule(availableSkills, skillsBudget, {
    builtinDir,
    globalDir,
    projectDir: projectSkillsDir,
  });

  const toolRegistry = new ToolRegistry();
  registerAllTools(toolRegistry, skillsModule, {
    enableOnDemand: config.tools?.enableOnDemand,
  });

  const pluginManager = new PluginManager();
  // Живой вкл/выкл: `setConfigValue("plugins.disabled", …)` (REPL, CLI, веб) сам
  // дёргает менеджер через этот шов — иначе поверхности разъезжаются.
  setPluginGateApplier((names) => pluginManager.setDisabledAll(names));
  // Стартовый deny-list — до загрузки плагинов, иначе он не к чему примениться.
  pluginManager.setDisabledAll(config.plugins?.disabled ?? []);

  // Черновики capabilities: одобренные проектом — грузим сразу, неодобренные
  // лежат на диске инертно. Наличие неодобренных черновиков — это предупреждение
  // при старте, а не тихая загрузка кода: согласие даётся явно
  // (`mma plugins drafts approve` или вопрос в `define_capability`).
  const draftHost = createDraftHost({ baseDir, pluginManager, configRef: { current: config } });
  const pending = pendingDrafts(baseDir);
  if (pending.length > 0) {
    logger.warn(t("plugin.drafts_pending", { count: String(pending.length) }));
  }

  // SystemInfo собирается здесь из готового профиля (в исходнике — сразу
  // после создания pluginManager; сайд-эффектов чтения профиля тут уже нет).
  const systemInfoContent = buildSystemInfo(config, baseDir, profile.compress());
  const systemInfoPrompt: PromptBlock = {
    content: systemInfoContent,
    priority: "critical",
    essential: true,
    estimatedTokens: estimateTokens(systemInfoContent),
  };

  return {
    baseDir,
    envReport,
    indexerModule,
    skillsModule,
    toolRegistry,
    pluginManager,
    draftHost,
    systemInfoPrompt,
  };
}
