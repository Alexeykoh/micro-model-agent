/**
 * Публичные экспорты пакета и библиотечный хелпер миграции конфига.
 */
export { DEFAULTS, loadConfig } from "./config/index";
export type { AppConfig, ProviderConfig, ContextBudget } from "./config/types";
export type { OrchestratorConfig } from "./config/types";
export { Logger } from "./logger/index";
export { PromptBuilder } from "./core/index";
export type {
  AgentState,
  PromptBlock,
  LLMResponse,
  AgentContext,
  HallucinationResult,
} from "./core/types";
export type { AgentModule } from "./modules/types";
// SDK плагинов: без этих типов внешний плагин вынужден дублировать контракт
// у себя (так делали оба примера в `examples/plugins`). Узкий `PluginManager`
// из `./tools/types` ниже остаётся — это роль, которую видит экзекутор.
export type {
  AgentPlugin,
  HostBridge,
  HostBridgeSubmitOptions,
  PluginPermission,
  PluginProvides,
  TurnSummary,
} from "./modules/types";
export { PLUGIN_PERMISSIONS } from "./modules/plugins/records";
export type { PluginLoadFailure, PluginRecord } from "./modules/plugins/records";
export type { RegisterResult } from "./modules/plugins/manager";
export { OpenAICompatProvider, TokenCounter, parseChunks, OrchestratorClient } from "./llm/index";
export type { LLMProvider, Message, Chunk, OpenAICompatConfig, ParsedResponse } from "./llm/index";
export {
  ToolRegistry,
  ToolExecutor,
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  createDirTool,
  deleteFileTool,
  moveFileTool,
  fileInfoTool,
  bashTool,
  subagentTool,
  webSearchTool,
  webFetchTool,
  webBrowseTool,
  createLoadSkillTool,
  pipelineRunTool,
  mcpCallTool,
  searchHistoryTool,
  registerAllTools,
} from "./tools/index";
export type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  ToolCall,
  PluginHook,
  PluginManager,
} from "./tools/types";
export { MigrationDetector, BackupManager } from "./migration/index";

import { MigrationDetector } from "./migration/detect";
import { BackupManager } from "./migration/backup";
import { t } from "./i18n/index";
import { defaultOutputBus, getDefaultChannel } from "./output";
import { homedir } from "os";
import { join } from "path";
import { MMA_DIR_NAME } from "./config/paths";

export function checkMigration(configDir?: string): void {
  const dir = configDir || join(homedir(), MMA_DIR_NAME);
  const detector = new MigrationDetector(dir);
  if (detector.needsMigration()) {
    // Терминальный подписчик должен существовать до отправки в шину: у
    // библиотечных потребителей нет другого eager-создания канала.
    getDefaultChannel();
    const backup = new BackupManager(dir);
    backup.backupConfig();
    backup.backupAll();
    const summary = backup.getBackupSummary();
    defaultOutputBus.log("info", "mma", t("migration.summary", { summary }));
  }
}
