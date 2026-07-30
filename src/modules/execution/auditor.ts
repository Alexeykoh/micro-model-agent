import { existsSync } from 'fs'
import { resolve } from 'path'
import { t } from '../../i18n/index'
import type { Plan } from './planner'

export interface AuditResult {
  passed: boolean
  missingFiles: string[]
  createdFiles: string[]
  modifiedFiles: string[]
  summary: string
}

export class Auditor {
  private baseDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  async audit(plan: Plan): Promise<AuditResult> {
    const allStepText = plan.steps.map(s => s.description).join(' ')
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

    const passed = missingFiles.length === 0
    const doneSteps = plan.steps.filter(s => s.status === 'done').length
    const totalSteps = plan.steps.length

    return {
      passed,
      missingFiles,
      createdFiles: existingFiles,
      modifiedFiles: [],
      summary: passed
        ? t('exec.audit_pass', { done: doneSteps, total: totalSteps, files: existingFiles.length })
        : t('exec.audit_fail', { done: doneSteps, total: totalSteps, files: missingFiles.length }),
    }
  }
}
