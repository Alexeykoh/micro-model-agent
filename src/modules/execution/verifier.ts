import { existsSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'

export interface VerificationItem {
  passed: boolean
  message: string
}

export interface StepVerificationResult {
  passed: boolean
  failed: VerificationItem[]
}

export class StepVerifier {
  private baseDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  async checkFileExists(path: string): Promise<VerificationItem> {
    const resolved = resolve(this.baseDir, path)
    const exists = existsSync(resolved)
    return {
      passed: exists,
      message: exists ? `File exists: ${path}` : `File not found: ${path}`,
    }
  }

  async runScript(scriptName: string): Promise<VerificationItem> {
    try {
      execSync(`bun run ${scriptName}`, {
        cwd: this.baseDir,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: 'pipe',
      })
      return { passed: true, message: `Script '${scriptName}' passed` }
    } catch (e: any) {
      return { passed: false, message: `Script '${scriptName}' failed: ${e.message}` }
    }
  }

  async verifyStep(stepDescription: string): Promise<StepVerificationResult> {
    const fileMatches = stepDescription.match(/\b[\w./-]+\.[a-z]+/gi) || []
    const results: VerificationItem[] = []

    for (const filePath of fileMatches) {
      const result = await this.checkFileExists(filePath)
      results.push(result)
    }

    return {
      passed: results.every(r => r.passed),
      failed: results.filter(r => !r.passed),
    }
  }
}
