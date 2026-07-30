import { existsSync } from 'fs'
import { resolve, extname } from 'path'
import { execSync } from 'child_process'
import { t } from '../../i18n/index'
import type { MoEPlan } from './types'
import type { AppConfig } from '../../config/types'
import { validateExpertConfig } from '../../config/experts'

export interface VerificationItem {
  passed: boolean
  message: string
}

export interface StepVerificationResult {
  passed: boolean
  syntaxValid: boolean
  failed: VerificationItem[]
}

export interface MoEVerificationResult {
  success: boolean
  errors: string[]
  warnings: string[]
  details: VerificationItem[]
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
      message: exists ? t('verify.file_exists', { path }) : t('verify.file_not_found', { path }),
    }
  }

  async runScript(scriptName: string): Promise<VerificationItem> {
    try {
      execSync(`bun run ${scriptName}`, {
        cwd: this.baseDir,
        encoding: 'utf-8',
        timeout: 60_000,
        stdio: 'pipe',
      })
      return { passed: true, message: t('verify.script_passed', { script: scriptName }) }
    } catch (e: any) {
      return { passed: false, message: t('verify.script_failed', { script: scriptName, message: e.message }) }
    }
  }

  async runTypeCheck(): Promise<VerificationItem> {
    const tsconfigPath = resolve(this.baseDir, 'tsconfig.json')
    if (!existsSync(tsconfigPath)) {
      return { passed: true, message: 'No tsconfig.json found — skipping type check' }
    }
    try {
      execSync('npx tsc --noEmit', {
        cwd: this.baseDir,
        encoding: 'utf-8',
        timeout: 60_000,
        stdio: 'pipe',
      })
      return { passed: true, message: 'TypeScript type check passed' }
    } catch (e: any) {
      const stderr = e.stderr?.toString() || e.stdout?.toString() || e.message
      return { passed: false, message: `TypeScript type check failed: ${stderr.slice(0, 500)}` }
    }
  }

  async runTests(): Promise<VerificationItem> {
    const pkgPath = resolve(this.baseDir, 'package.json')
    if (!existsSync(pkgPath)) {
      return { passed: true, message: 'No package.json found — skipping tests' }
    }
    try {
      const pkg = JSON.parse(require('fs').readFileSync(pkgPath, 'utf-8'))
      if (!pkg.scripts?.test) {
        return { passed: true, message: 'No test script defined — skipping tests' }
      }
    } catch { /* fall through — attempt to run */ }
    return this.runScript('test')
  }

  async verifyArtifactFiles(files: string[]): Promise<VerificationItem[]> {
    return Promise.all(files.map(f => this.checkFileExists(f)))
  }

  async verifyMoEManifest(plan: MoEPlan, config: AppConfig, allToolTags: string[]): Promise<MoEVerificationResult> {
    const errors: string[] = []
    const warnings: string[] = []
    const details: VerificationItem[] = []

    const expertErrors = validateExpertConfig(config, allToolTags)
    for (const err of expertErrors) {
      errors.push(err)
      details.push({ passed: false, message: err })
    }

    const tscResult = await this.runTypeCheck()
    details.push(tscResult)
    if (!tscResult.passed) {
      errors.push(tscResult.message)
    }

    for (const sub of plan.subtasks) {
      const fileChecks = await this.verifyArtifactFiles(sub.allowed_files || [])
      for (const check of fileChecks) {
        details.push(check)
        if (!check.passed) {
          errors.push(check.message)
        }
      }
    }

    return {
      success: errors.length === 0,
      errors,
      warnings,
      details,
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
          results.push({ passed: false, message: t('verify.syntax_error', { path: filePath }) })
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
