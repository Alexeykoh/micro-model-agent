export interface UpdateCheckResult {
  updateAvailable: boolean
  current: string
  latest?: string
  error?: string
}

export class Updater {
  private currentVersion: string
  private packageName: string

  constructor(currentVersion: string, packageName: string) {
    this.currentVersion = currentVersion
    this.packageName = packageName
  }

  getCurrentVersion(): string {
    return this.currentVersion
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
}
