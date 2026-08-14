import { resolveSpawnCommand } from '../lsp/command'

export interface UpdateCheckResult {
  updateAvailable: boolean
  current: string
  latest?: string
  error?: string
}

export interface InstallResult {
  success: boolean
  installed?: string
  error?: string
}

export type InstallRunner = (
  command: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
) => Promise<{ error?: string }>

const defaultRunner: InstallRunner = async (command, args, options) => {
  const { execFile } = await import('child_process')
  return new Promise((resolve) => {
    execFile(command, args, options, (err) => resolve({ error: err?.message }))
  })
}

export class Updater {
  private currentVersion: string
  private packageName: string
  private runner: InstallRunner

  constructor(currentVersion: string, packageName: string, runner?: InstallRunner) {
    this.currentVersion = currentVersion
    this.packageName = packageName
    this.runner = runner ?? defaultRunner
  }

  getCurrentVersion(): string {
    return this.currentVersion
  }

  getPackageName(): string {
    return this.packageName
  }

  async check(): Promise<UpdateCheckResult> {
    try {
      const response = await fetch(`https://registry.npmjs.org/${this.packageName}`, {
        headers: { Accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(5000),
      })

      if (!response.ok) {
        return { updateAvailable: false, current: this.currentVersion, error: `HTTP ${response.status}` }
      }

      const data: any = await response.json()
      const latest = data['dist-tags']?.latest

      if (!latest) {
        return { updateAvailable: false, current: this.currentVersion, error: 'No latest tag' }
      }

      const updateAvailable = latest !== this.currentVersion
      return { updateAvailable, current: this.currentVersion, latest }

    } catch (e: any) {
      return { updateAvailable: false, current: this.currentVersion, error: e.message }
    }
  }

  /**
   * Install the latest version globally via `npm install -g`.
   * Returns an InstallResult (never throws).
   */
  async install(latest: string): Promise<InstallResult> {
    try {
      const command = resolveSpawnCommand('npm')
      const res = await this.runner(command, ['install', '-g', `${this.packageName}@${latest}`], {
        timeout: 120000,
        windowsHide: true,
      })
      if (res.error) return { success: false, error: res.error }
      return { success: true, installed: latest }
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      return { success: false, error: msg.split('\n')[0] }
    }
  }
}
