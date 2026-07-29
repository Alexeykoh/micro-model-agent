export interface HallucinationCheckResult {
  status: 'pass' | 'warn' | 'retry' | 'block'
  reason?: string
}

const FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'md', 'yaml', 'yml',
  'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp',
  'html', 'css', 'scss', 'less', 'vue', 'svelte',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'txt', 'log', 'env', 'gitignore', 'dockerignore',
  'dockerfile', 'makefile', 'cmake', 'toml', 'xml',
  'sql', 'graphql', 'proto', 'wasm',
])

const VERSION_PATTERN = /^\d+(\.\d+)*$/

export class FactualCheck {
  private knownPaths: Set<string> = new Set()
  private createdPaths: Set<string> = new Set()

  trackReadPath(path: string): void {
    this.knownPaths.add(path)
  }

  trackCreatedPath(path: string): void {
    this.knownPaths.add(path)
    this.createdPaths.add(path)
  }

  validate(response: string): HallucinationCheckResult {
    const pathRegex = /[\w\-./]+\.\w+/g
    const mentionedPaths = response.match(pathRegex) || []

    const unknownPaths = mentionedPaths.filter(p => {
      if (this.knownPaths.has(p)) return false
      if (VERSION_PATTERN.test(p)) return false

      const ext = p.split('.').pop()?.toLowerCase() || ''
      if (!FILE_EXTENSIONS.has(ext)) return false

      const urlPattern = new RegExp(`https?://[^\\s]*${p.split('/').pop()?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      if (urlPattern.test(response)) return false

      return true
    })

    if (unknownPaths.length > 0) {
      const uniquePaths = [...new Set(unknownPaths)]
      return {
        status: 'warn',
        reason: `Mentioned file paths not found in known files: ${uniquePaths.slice(0, 3).join(', ')}`,
      }
    }

    return { status: 'pass' }
  }
}
