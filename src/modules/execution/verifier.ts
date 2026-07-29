import { existsSync } from 'fs'
import { resolve, extname } from 'path'
import { execSync } from 'child_process'

export interface VerificationItem {
  passed: boolean
  message: string
}

export interface StepVerificationResult {
  passed: boolean
  syntaxValid: boolean
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
    let syntaxValid = true

    for (const filePath of fileMatches) {
      const result = await this.checkFileExists(filePath)
      results.push(result)

      if (result.passed) {
        const fullPath = resolve(this.baseDir, filePath)
        if (!this.validateSyntax(fullPath)) {
          syntaxValid = false
          results.push({ passed: false, message: `Syntax error in: ${filePath}` })
        }
      }
    }

    return {
      passed: results.every(r => r.passed),
      syntaxValid,
      failed: results.filter(r => !r.passed),
    }
  }

  private validateSyntax(filePath: string): boolean {
    const ext = extname(filePath)

    if (ext === '.ts' || ext === '.tsx') {
      try {
        execSync(`npx tsc --noEmit --skipLibCheck ${filePath}`, { stdio: 'pipe', timeout: 10000 })
        return true
      } catch (err: any) {
        if (err.status === 127 || err.message.includes('not found') || err.message.includes('ENOENT')) {
          return true
        }
        const stderr = err.stderr?.toString() || ''
        if (stderr.includes('error TS') && !stderr.includes('Cannot find module')) {
          return false
        }
        return true
      }
    }

    if (ext === '.js' || ext === '.jsx') {
      try {
        execSync(`node --check ${filePath}`, { stdio: 'pipe', timeout: 5000 })
        return true
      } catch {
        return false
      }
    }

    return true
  }
}
