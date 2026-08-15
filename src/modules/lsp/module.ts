import type { AgentModule } from '../types'
import type { AgentPlugin } from '../types'
import type { ToolContext, ToolCall, ToolResult } from '../../tools/types'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { LspClient } from './client'
import { getServerForFile, DEFAULT_LSP_CONFIG } from './config'
import { findProjectRoot } from './project-root'
import { t } from '../../i18n/index'
import type { LspConfig, LspServerConfig, LspDiagnostic } from './types'

const severityLabels: Record<number, string> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
}

/**
 * Consecutive LSP failures before a server is disabled for the session. A dead
 * server (not installed, npx auto-install failed, path missing) otherwise
 * spams `[LSP check failed]` on EVERY write, teaching the model to ignore the
 * signal entirely (observed: ses_mst2r0r5 had LSP dead all session and the
 * model never reacted). After the threshold we say so once and stop the noise
 * for that server — a CSS timeout must not take TypeScript checks down too.
 */
const MAX_CONSECUTIVE_LSP_FAILURES = 3

export class LspModule implements AgentModule {
  name = 'lsp'
  private config: LspConfig
  private client = new LspClient()
  private failuresByServer = new Map<string, number>()
  private disabledServers = new Set<string>()

  constructor(config?: Partial<LspConfig>) {
    this.config = { ...DEFAULT_LSP_CONFIG, ...config }
  }

  /** Test hook: has the module disabled any LSP server for the session? */
  isLspDisabled(): boolean {
    return this.disabledServers.size > 0
  }

  /** Test hook: is the given server (config-derived key) disabled? */
  isServerDisabled(key: string): boolean {
    return this.disabledServers.has(key)
  }

  /** Stable server identity derived from the config. */
  private serverKey(server: LspServerConfig): string {
    return `${server.command}:${(server.args ?? []).join(' ')}`
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

        const key = self.serverKey(serverConfig)
        if (self.disabledServers.has(key)) return

        const projectRoot = findProjectRoot(
          fullPath,
          _ctx.baseDir,
          serverConfig.workspaceMarkers ?? [],
        )

        try {
          const diagnostics = await self.client.checkFile(fullPath, _ctx.baseDir, serverConfig, projectRoot)
          self.failuresByServer.set(key, 0)
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
          const failures = (self.failuresByServer.get(key) ?? 0) + 1
          self.failuresByServer.set(key, failures)
          try {
            _ctx.logger?.warn(`LSP check failed for ${filePath}: ${msg}`)
          } catch {}
          if (failures >= MAX_CONSECUTIVE_LSP_FAILURES) {
            // One loud, actionable message, then stop the per-write noise for
            // the rest of the session. The model must not learn to ignore LSP.
            self.disabledServers.add(key)
            result.output += `\n\n[LSP disabled: ${t('lsp.unavailable')}]`
          } else {
            result.output += `\n\n[LSP check failed]: ${msg}`
          }
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
