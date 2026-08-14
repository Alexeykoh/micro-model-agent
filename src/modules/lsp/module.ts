import type { AgentModule } from '../types'
import type { AgentPlugin } from '../types'
import type { ToolContext, ToolCall, ToolResult } from '../../tools/types'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { LspClient } from './client'
import { getServerForFile, DEFAULT_LSP_CONFIG } from './config'
import { findProjectRoot } from './project-root'
import type { LspConfig } from './types'
import type { LspDiagnostic } from './types'

const severityLabels: Record<number, string> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
}

export class LspModule implements AgentModule {
  name = 'lsp'
  private config: LspConfig
  private client = new LspClient()

  constructor(config?: Partial<LspConfig>) {
    this.config = { ...DEFAULT_LSP_CONFIG, ...config }
  }

  getPlugin(): AgentPlugin {
    const self = this
    return {
      name: 'lsp-check',
      priority: 15,
      onAfterTool: async (_ctx: ToolContext, call: ToolCall, result: ToolResult) => {
        if (!self.config.enabled) return
        if (call.name !== 'write_file' && call.name !== 'edit_file') return
        if (!result.success) return

        const filePath = String(call.arguments.path ?? '')
        if (!filePath) return

        const fullPath = resolve(_ctx.baseDir, filePath)
        if (!existsSync(fullPath)) return

        const serverConfig = getServerForFile(fullPath, self.config)
        if (!serverConfig) return

        const projectRoot = findProjectRoot(
          fullPath,
          _ctx.baseDir,
          serverConfig.workspaceMarkers ?? [],
        )

        try {
          const diagnostics = await self.client.checkFile(fullPath, _ctx.baseDir, serverConfig, projectRoot)
          const errors = diagnostics.filter((d) => d.severity === 1)
          const warnings = diagnostics.filter((d) => d.severity === 2)

          if (errors.length > 0) {
            const items = formatDiagnostics(errors, fullPath)
            result.output += `\n\n[LSP errors]:\n${items}`
          }
          if (warnings.length > 0) {
            const items = formatDiagnostics(warnings, fullPath)
            result.output += `\n\n[LSP warnings]:\n${items}`
          }
        } catch (e) {
          // Surface failures instead of silently returning [] — a dead LSP
          // previously produced ZERO diagnostics across whole sessions and the
          // model only found type errors reactively via `bun run build`.
          const msg = e instanceof Error ? e.message : String(e)
          try {
            _ctx.logger?.warn(`LSP check failed for ${filePath}: ${msg}`)
          } catch {}
          result.output += `\n\n[LSP check failed]: ${msg}`
        }
      },
    }
  }
}

function formatDiagnostics(diagnostics: LspDiagnostic[], filePath: string): string {
  const filename = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath
  return diagnostics
    .slice(0, 5)
    .map((d) => {
      const line = d.range.start.line + 1
      const col = d.range.start.character + 1
      const sev = severityLabels[d.severity] ?? 'unknown'
      return `  ${filename}(${line},${col}): ${sev}: ${d.message}`
    })
    .join('\n')
}
