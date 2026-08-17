import type { ToolDefinition } from "./types";

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): string[] {
    return Array.from(this.tools.keys()).sort();
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getByTags(tags: string[]): ToolDefinition[] {
    return this.getAll().filter((t) => {
      if (!t.tags || t.tags.length === 0) return false;
      return tags.some((tag) => t.tags!.includes(tag));
    });
  }

  /**
   * Tools to expose to the LLM. Always includes `alwaysOn` tools, then tools
   * matching the given tags. When no tags are given, returns every registered
   * tool (backward-compatible). Duplicates are impossible because the
   * alwaysOn + tagged sets are unioned by name.
   */
  getAllForLLM(
    tags?: string[],
  ): Array<Pick<ToolDefinition, "name" | "description" | "parameters" | "boundedOutput">> {
    const all = this.getAll();
    const tagSet = new Set(tags ?? []);
    const selected =
      tagSet.size === 0
        ? all
        : all.filter((t) => t.alwaysOn || (t.tags && t.tags.some((tag) => tagSet.has(tag))));
    return selected.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      boundedOutput: t.boundedOutput,
    }));
  }
}
