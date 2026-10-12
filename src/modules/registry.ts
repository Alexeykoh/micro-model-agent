import type { AgentModule, AgentPlugin } from "./types";
import type { PromptBlock } from "../core/types";
import type { ToolDefinition } from "../tools/types";

export class ModuleRegistry {
  private modules: Map<string, AgentModule> = new Map();

  register(mod: AgentModule): this {
    this.modules.set(mod.name, mod);
    return this;
  }

  get(name: string): AgentModule | undefined {
    return this.modules.get(name);
  }

  listModules(): string[] {
    return Array.from(this.modules.keys()).sort();
  }

  collectPromptBlocks(exclude: string[] = []): PromptBlock[] {
    const blocks: PromptBlock[] = [];
    for (const [name, mod] of this.modules) {
      if (exclude.includes(name)) continue;
      if (mod.getSystemPromptBlock) {
        const block = mod.getSystemPromptBlock();
        // Владелец блока — сам модуль (INV-1/17): модуль не обязан знать, как
        // его звать в логе, реестр проставляет `source` из регистрационного имени.
        if (block) blocks.push(block.source ? block : { ...block, source: name });
      }
    }
    return blocks;
  }

  collectToolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const [name, mod] of this.modules) {
      if (mod.getToolDefinitions) {
        const defs = mod.getToolDefinitions();
        // Владелец тула — модуль (INV-1/2): модуль не обязан знать, как его
        // звать, реестр проставляет `owner` из регистрационного имени.
        if (defs) for (const def of defs) tools.push(def.owner ? def : { ...def, owner: name });
      }
    }
    return tools;
  }

  collectPlugins(): AgentPlugin[] {
    const plugins: AgentPlugin[] = [];
    for (const mod of this.modules.values()) {
      if (mod.getPlugin) {
        const plugin = mod.getPlugin();
        if (plugin) plugins.push(plugin);
      }
    }
    return plugins;
  }
}
