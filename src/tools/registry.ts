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

  getAllForLLM(): Array<Pick<ToolDefinition, 'name' | 'description' | 'parameters'>> {
    return this.getAll().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))
  }
}
