import type { ToolDefinition } from './types'

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map()

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): string[] {
    return Array.from(this.tools.keys()).sort()
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  getByTags(tags: string[]): ToolDefinition[] {
    return this.getAll().filter(t => {
      if (!t.tags || t.tags.length === 0) return false
      return tags.some(tag => t.tags!.includes(tag))
    })
  }

  getAllForLLM(tags?: string[]): Array<Pick<ToolDefinition, 'name' | 'description' | 'parameters' | 'boundedOutput'>> {
    const tools = tags ? this.getByTags(tags) : this.getAll()
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      boundedOutput: t.boundedOutput,
    }))
  }
}
