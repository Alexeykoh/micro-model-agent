import { readdir, stat } from 'fs/promises'
import { resolve, relative } from 'path'
import type { LspDiagnostic, LspConfig } from './types'
import { getServerForFile } from './config'

/** lsp_check directory mode: walk depth and per-call file cap. */
export const MAX_LSP_CHECK_FILES = 15
const MAX_LSP_WALK_DEPTH = 4
const SKIP_DIRS = new Set(['node_modules', '.git', '.mma', 'dist'])

export const severityLabels: Record<number, string> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
}

/**
 * Resolve the target to a file (single check) or a bounded list of source
 * files (directory check, capped at MAX_LSP_CHECK_FILES). Only files with a
 * configured LSP server are collected, so unsupported extensions are simply
 * not checked rather than producing noise.
 */
export async function collectCheckFiles(
  resolved: string,
  config: LspConfig,
): Promise<string[]> {
  const info = await stat(resolved).catch(() => null)
  if (!info) return []
  if (info.isFile()) return [resolved]
  const out: string[] = []
  await walkDir(resolved, 0, out, config)
  return out
}

async function walkDir(
  dir: string,
  depth: number,
  out: string[],
  config: LspConfig,
): Promise<void> {
  if (depth > MAX_LSP_WALK_DEPTH || out.length >= MAX_LSP_CHECK_FILES) return
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (out.length >= MAX_LSP_CHECK_FILES) break
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walkDir(resolve(dir, entry.name), depth + 1, out, config)
    } else if (
      entry.isFile() &&
      getServerForFile(resolve(dir, entry.name), config)
    ) {
      out.push(resolve(dir, entry.name))
    }
  }
}

export function formatCheckDiagnostics(
  items: Array<{ file: string; diag: LspDiagnostic }>,
  baseDir: string,
): string {
  return items
    .slice(0, 40)
    .map(({ file, diag }) => {
      const rel = relative(baseDir, file).replace(/\\/g, '/')
      const line = diag.range.start.line + 1
      const col = diag.range.start.character + 1
      const sev = severityLabels[diag.severity] ?? 'unknown'
      return `  ${rel}(${line},${col}): ${sev}: ${diag.message}`
    })
    .join('\n')
}