export { DEFAULTS, loadConfig } from './config/index'
export type { AppConfig, ProviderConfig, ContextBudget } from './config/types'
export type { OrchestratorConfig } from './config/types'
export { Logger } from './logger/index'
export { PromptBuilder } from './core/index'
export type { AgentState, PromptBlock, LLMResponse, AgentContext, HallucinationResult } from './core/types'
export type { AgentModule } from './modules/types'
export { OpenAICompatProvider, TokenCounter, parseChunks, OrchestratorClient } from './llm/index'
export type { LLMProvider, Message, Chunk, OpenAICompatConfig, ParsedResponse } from './llm/index'
export {
  ToolRegistry, ToolExecutor,
  readFileTool, writeFileTool, editFileTool,
  globTool, grepTool, listDirTool, createDirTool,
  deleteFileTool, moveFileTool, fileInfoTool,
  bashTool, subagentTool,
  webSearchTool, webFetchTool, webBrowseTool,
  planTool, todoTool, questionTool, approveTool,
  loadSkillTool, pipelineRunTool, mcpCallTool, searchHistoryTool,
  registerAllTools,
} from './tools/index'
export type { ToolDefinition, ToolContext, ToolResult, ToolCall, PluginHook, PluginManager } from './tools/types'
export { MigrationDetector, BackupManager } from './migration/index'

import { MigrationDetector } from './migration/detect'
import { BackupManager } from './migration/backup'
import { homedir } from 'os'
import { join } from 'path'

export function checkMigration(configDir?: string): void {
  const dir = configDir || join(homedir(), '.mma')
  const detector = new MigrationDetector(dir)
  if (detector.needsMigration()) {
    const backup = new BackupManager(dir)
    backup.backupConfig()
    backup.backupAll()
    const summary = backup.getBackupSummary()
    console.log(`[MMA] ${summary}`)
  }
}
