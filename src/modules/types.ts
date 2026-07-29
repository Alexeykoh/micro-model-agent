export interface AgentPlugin {
  name: string
  priority?: number
  onBuildPrompt?(): string | null
  onBeforeTool?(ctx: any, call: any): boolean | Promise<boolean>
  onAfterTool?(ctx: any, result: any): void | Promise<void>
  onError?(ctx: any, error: Error): void
  onSessionStart?(ctx: any): void
  onSessionEnd?(ctx: any): void
}
