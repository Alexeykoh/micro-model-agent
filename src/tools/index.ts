import { ToolRegistry } from './registry'
import { ToolExecutor } from './executor'
import type { ToolDefinition, ToolContext, ToolResult, ToolCall, PluginHook, PluginManager } from './types'
import { readFileTool } from './read-file'
import { writeFileTool } from './write-file'
import { editFileTool } from './edit-file'
import { globTool } from './glob-tool'
import { grepTool } from './grep-tool'
import { listDirTool } from './list-dir'
import { createDirTool } from './create-dir'
import { deleteFileTool } from './delete-file'
import { moveFileTool } from './move-file'
import { fileInfoTool } from './file-info'
import { bashTool } from './bash'
import { subagentTool } from './subagent'
import { webSearchTool } from './web-search'
import { webFetchTool } from './web-fetch'
import { webBrowseTool } from './web-browse'
import { questionTool } from './question'
import { approveTool } from './approve'
import { createLoadSkillTool } from './load-skill'
import { pipelineRunTool } from './pipeline-run'
import { mcpCallTool } from './mcp-call'
import { searchHistoryTool } from './search-history'
import { createBrowserTool } from './browser'
import type { SkillsModule } from '../modules/skills/module'

export { ToolRegistry, ToolExecutor }
export type { ToolDefinition, ToolContext, ToolResult, ToolCall, PluginHook, PluginManager }
export {
  readFileTool, writeFileTool, editFileTool,
  globTool, grepTool, listDirTool, createDirTool,
  deleteFileTool, moveFileTool, fileInfoTool,
  bashTool, subagentTool,
  webSearchTool, webFetchTool, webBrowseTool,
  questionTool, approveTool,
  createLoadSkillTool, pipelineRunTool, mcpCallTool, searchHistoryTool,
  createBrowserTool,
}

export function registerAllTools(registry: ToolRegistry, skillsModule?: SkillsModule): void {
  const tools: ToolDefinition[] = [
    readFileTool, writeFileTool, editFileTool,
    globTool, grepTool, listDirTool, createDirTool,
    deleteFileTool, moveFileTool, fileInfoTool,
    bashTool, subagentTool,
    webSearchTool, webFetchTool, webBrowseTool,
    questionTool, approveTool,
    pipelineRunTool, mcpCallTool, searchHistoryTool,
  ]

  if (skillsModule) {
    tools.push(createLoadSkillTool(skillsModule))
  }

  for (const tool of tools) {
    registry.register(tool)
  }
}
