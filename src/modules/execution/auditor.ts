import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { resolve, join } from 'path'
import { t } from '../../i18n/index'
import type { Plan } from './planner'

const MASS_EDIT_THRESHOLD = 10

export interface AuditResult {
  passed: boolean
  missingFiles: string[]
  createdFiles: string[]
  modifiedFiles: string[]
  summary: string
  typeCheckError: string | null
  massEditWarning: string | null
}

export class Auditor {
  private baseDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  async audit(plan: Plan): Promise<AuditResult> {
    const allStepText = plan.steps
      .map(s => s.description.replace(/\([^)]*\)/g, ' '))
      .join(' ')
    const fileMatches = allStepText.match(/\b[\w./-]+\.[a-z]+/gi) || []
    const uniqueFiles = [...new Set(fileMatches)]

    const missingFiles: string[] = []
    const existingFiles: string[] = []

    for (const filePath of uniqueFiles) {
      const resolved = resolve(this.baseDir, filePath)
      if (existsSync(resolved)) {
        existingFiles.push(filePath)
      } else {
        missingFiles.push(filePath)
      }
    }

    const doneSteps = plan.steps.filter(s => s.status === 'done').length
    const totalSteps = plan.steps.length

    const typeCheckError = await this.runProjectTypeCheck()

    let massEditWarning: string | null = null
    if (uniqueFiles.length > MASS_EDIT_THRESHOLD) {
      massEditWarning = t('exec.mass_edit_warning', { count: String(uniqueFiles.length) })
    }

    const passed = missingFiles.length === 0 && !typeCheckError

    let summary: string
    if (passed) {
      summary = t('exec.audit_pass', { done: doneSteps, total: totalSteps, files: existingFiles.length })
    } else {
      const missingCount = missingFiles.length
      if (typeCheckError) {
        summary = t('exec.audit_fail_typecheck', { done: doneSteps, total: totalSteps, missing: missingCount, typeError: typeCheckError })
      } else {
        summary = t('exec.audit_fail', { done: doneSteps, total: totalSteps, files: missingCount })
      }
    }

    return {
      passed,
      missingFiles,
      createdFiles: existingFiles,
      modifiedFiles: [],
      summary,
      typeCheckError,
      massEditWarning,
    }
  }

  private async runProjectTypeCheck(): Promise<string | null> {
    const tsconfigPath = join(this.baseDir, 'tsconfig.json')
    if (!existsSync(tsconfigPath)) {
      return null
    }

    try {
      execSync(`npx tsc --noEmit --skipLibCheck`, { cwd: this.baseDir, stdio: 'pipe', timeout: 30000 })
      return null
    } catch (err: any) {
      if (err.status === 127 || err.message.includes('not found') || err.message.includes('ENOENT')) {
        return null
      }
      const stderr = err.stderr?.toString() || err.stdout?.toString() || ''
      if (stderr.includes('error TS')) {
        const firstError = stderr.split('\n').find((line: string) => line.includes('error TS')) || 'TypeScript type error'
        return firstError.trim()
      }
      return null
    }
  }
}
