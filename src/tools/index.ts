import { ToolRegistry } from "./registry";
import { ToolExecutor } from "./executor";
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  ToolCall,
  PluginHook,
  PluginManager,
} from "./types";
import { readFileTool } from "./read-file";
import { writeFileTool } from "./write-file";
import { editFileTool } from "./edit-file";
import { globTool } from "./glob-tool";
import { grepTool } from "./grep-tool";
import { listDirTool } from "./list-dir";
import { createDirTool } from "./create-dir";
import { deleteFileTool } from "./delete-file";
import { moveFileTool } from "./move-file";
import { fileInfoTool } from "./file-info";
import { bashTool } from "./bash";
import { processListTool } from "./process-list";
import { processLogTool } from "./process-log";
import { processKillTool } from "./process-kill";
import { subagentTool } from "./subagent";
import { chunkQueryTool } from "./chunk-query";
import { webSearchTool } from "./web-search";
import { webFetchTool } from "./web-fetch";
import { webBrowseTool } from "./web-browse";
import { downloadFileTool } from "./download-file";
// questionTool and approveTool removed — interactive menus are too disruptive for small models.
// The model should ask questions as plain text in its response instead.
// import { questionTool } from './question'
// import { approveTool } from './approve'
import { createLoadSkillTool } from "./load-skill";
import { pipelineRunTool } from "./pipeline-run";
import { mcpCallTool } from "./mcp-call";
import { searchHistoryTool } from "./search-history";
import { rememberTool } from "./remember";
import { recallTool } from "./recall";
import { createBrowserTool } from "./browser";
import { attachImageTool } from "./attach-image";
import { enableToolsTool } from "./enable-tools";
import { sessionInfoTool } from "./session-info";
import type { SkillsModule } from "../modules/skills/module";

export { ToolRegistry, ToolExecutor };
export { filterToolsByTags } from "./filter-tools";
export type { ToolDefinition, ToolContext, ToolResult, ToolCall, PluginHook, PluginManager };
export {
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
  chunkQueryTool,
  processListTool,
  processLogTool,
  processKillTool,
  webSearchTool,
  webFetchTool,
  webBrowseTool,
  downloadFileTool,
  createLoadSkillTool,
  pipelineRunTool,
  mcpCallTool,
  searchHistoryTool,
  rememberTool,
  recallTool,
  createBrowserTool,
  attachImageTool,
  enableToolsTool,
  sessionInfoTool,
};

export function registerAllTools(
  registry: ToolRegistry,
  skillsModule?: SkillsModule,
  opts?: { enableOnDemand?: boolean },
): void {
  const tools: ToolDefinition[] = [
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
    chunkQueryTool,
    processListTool,
    processLogTool,
    processKillTool,
    webSearchTool,
    webFetchTool,
    webBrowseTool,
    downloadFileTool,
    pipelineRunTool,
    mcpCallTool,
    searchHistoryTool,
    attachImageTool,
    sessionInfoTool,
  ];

  // On-demand tool activation is the default. When explicitly disabled
  // (enableOnDemand: false), the tool is not registered at all — combined
  // with an empty defaultTags this restores the legacy all-tools behavior.
  if (opts?.enableOnDemand !== false) {
    tools.push(enableToolsTool);
  }

  if (skillsModule) {
    tools.push(createLoadSkillTool(skillsModule));
  }

  for (const tool of tools) {
    registry.register(tool);
  }
}
