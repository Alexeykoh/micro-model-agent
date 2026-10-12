/**
 * Контракт MCP-модуля для `ModuleHost` (INV-5/8).
 *
 * Модуль объявляет свою критичность сам: MCP не критичен (медленный/чужой
 * сервер не должен валить boot), а таймаут `setup` принадлежит хосту, не
 * модулю — раньше он был ad-hoc в bootstrap.
 */
import type { ModuleDef } from "../../core/module-host";
import type { MCPModule } from "./module";

/** Определение MCP для `ModuleHost`: не критичен, setup = `initialize()`. */
export function mcpModuleDef(mcp: MCPModule): ModuleDef {
  return {
    name: "mcp",
    critical: false,
    setup: () => mcp.initialize(),
    tools: () => mcp.getToolDefinitions(),
    promptBlocks: () => {
      const block = mcp.getSystemPromptBlock();
      return block ? [block] : null;
    },
    hooks: () => mcp.getPlugin(),
  };
}
