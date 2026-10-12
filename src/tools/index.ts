/** Точка сборки каталога тулов: импорты, реэкспорты, регистрация. */
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
import { processWaitTool } from "./process-wait";
import { subagentTool } from "./subagent";
import { chunkQueryTool } from "./chunk-query";
import { webSearchTool } from "./web-search";
import { webFetchTool } from "./web-fetch";
import { webBrowseTool } from "./web-browse";
import { downloadFileTool } from "./download-file";
// question/approve — основной набор: question покрывает выбор + свободный
// текст (с pre-check памяти), approve — явное Yes/No (reject даёт success:false,
// и цикл трактует это как сигнал сбоя, а не текст ответа).
import { questionTool } from "./question";
import { approveTool } from "./approve";
import { createLoadSkillTool } from "./load-skill";
import { pipelineRunTool } from "./pipeline-run";
import { mcpCallTool } from "./mcp-call";
import { searchHistoryTool } from "./search-history";
import { rememberTool } from "./remember";
import { recallTool } from "./recall";
import { meetDoneTool } from "./meet-done";
import { createBrowserTool } from "./browser";
import { attachImageTool } from "./attach-image";
import { defineCapabilityTool } from "./define-capability";
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
  processWaitTool,
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
  meetDoneTool,
  createBrowserTool,
  attachImageTool,
  enableToolsTool,
  sessionInfoTool,
  questionTool,
  approveTool,
};

/** Регистрирует все тулы; опционально — on-demand тул и скиллы. */
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
    processWaitTool,
    webSearchTool,
    webFetchTool,
    webBrowseTool,
    downloadFileTool,
    pipelineRunTool,
    mcpCallTool,
    searchHistoryTool,
    attachImageTool,
    sessionInfoTool,
    meetDoneTool,
    defineCapabilityTool,
    questionTool,
    approveTool,
  ];

  // On-demand активация — дефолт. При явном enableOnDemand:false тул не
  // регистрируется вовсе — с пустым defaultTags это legacy-режим «все тулы».
  if (opts?.enableOnDemand !== false) {
    tools.push(enableToolsTool);
  }

  if (skillsModule) {
    tools.push(createLoadSkillTool(skillsModule));
  }

  for (const tool of tools) {
    // Встроенные тулы ядра (INV-1/2): один общий владелец `core`.
    registry.register(tool, "core");
  }
}
