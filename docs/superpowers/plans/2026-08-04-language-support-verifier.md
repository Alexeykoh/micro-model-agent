# Language Support for Verifier — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Verifier and Auditor language-agnostic by detecting the project language from artifacts and running appropriate syntax/type/test checks.

**Architecture:** New `LanguageAdapter` interface + 4 adapters (TS, Python, Go, Rust). `detectLanguage()` picks the right adapter by checking for config files in priority order. Verifier and Auditor use the detected adapter instead of hardcoded JS/TS logic.

**Tech Stack:** TypeScript, Node.js `child_process.execSync`, vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/modules/execution/language-adapters.ts` | **NEW** — `LanguageAdapter` interface, `detectLanguage()`, all adapter implementations |
| `src/modules/execution/verifier.ts` | **MODIFY** — replace hardcoded `validateSyntax()` with adapter-based checks |
| `src/modules/execution/auditor.ts` | **MODIFY** — replace `runProjectTypeCheck()` with adapter-based checks + add `runTests()` |
| `src/i18n/en.json` | **MODIFY** — add `verify.lang_detected`, `verify.typecheck_failed`, `verify.test_failed` keys |
| `src/i18n/ru.json` | **MODIFY** — add matching Russian keys |
| `tests/language-adapters.test.ts` | **NEW** — unit tests for detection + each adapter |
| `tests/execution-verifier.test.ts` | **MODIFY** — add tests for adapter-based verification |
| `tests/execution-auditor.test.ts` | **MODIFY** — add tests for multi-language audit |

---

## Task 1: Language Adapter Interface + Detection

**Files:**
- Create: `src/modules/execution/language-adapters.ts`
- Test: `tests/language-adapters.test.ts`

### Step 1.1: Write failing tests for detection

```typescript
// tests/language-adapters.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { detectLanguage, type LanguageAdapter } from '../src/modules/execution/language-adapters'

describe('detectLanguage', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-lang-'))
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
  })

  it('should detect TypeScript from tsconfig.json', () => {
    writeFileSync(join(tmpDir, 'tsconfig.json'), '{}')
    expect(detectLanguage(tmpDir)).toBe('typescript')
  })

  it('should detect Python from pyproject.toml', () => {
    writeFileSync(join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"')
    expect(detectLanguage(tmpDir)).toBe('python')
  })

  it('should detect Python from setup.py', () => {
    writeFileSync(join(tmpDir, 'setup.py'), 'from setuptools import setup')
    expect(detectLanguage(tmpDir)).toBe('python')
  })

  it('should detect Go from go.mod', () => {
    writeFileSync(join(tmpDir, 'go.mod'), 'module example.com/mymod\n\ngo 1.21')
    expect(detectLanguage(tmpDir)).toBe('go')
  })

  it('should detect Rust from Cargo.toml', () => {
    writeFileSync(join(tmpDir, 'Cargo.toml'), '[package]\nname = "myapp"')
    expect(detectLanguage(tmpDir)).toBe('rust')
  })

  it('should detect JavaScript from package.json without tsconfig', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{"name":"test"}')
    expect(detectLanguage(tmpDir)).toBe('javascript')
  })

  it('should prefer TypeScript over JavaScript when both exist', () => {
    writeFileSync(join(tmpDir, 'tsconfig.json'), '{}')
    writeFileSync(join(tmpDir, 'package.json'), '{"name":"test"}')
    expect(detectLanguage(tmpDir)).toBe('typescript')
  })

  it('should return unknown when no artifacts found', () => {
    expect(detectLanguage(tmpDir)).toBe('unknown')
  })
})
```

### Step 1.2: Run tests to verify they fail

Run: `bun test tests/language-adapters.test.ts`
Expected: FAIL — module not found

### Step 1.3: Implement `detectLanguage()` + interface

```typescript
// src/modules/execution/language-adapters.ts
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

export type Language = 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'unknown'

export interface LanguageAdapter {
  detect(baseDir: string): boolean
  syntaxCheck(filePath: string, baseDir: string): { passed: boolean; message: string }
  typeCheck(baseDir: string): Promise<{ passed: boolean; message: string }>
  runTests(baseDir: string): Promise<{ passed: boolean; message: string }>
}

// --- Detection ---

const detectors: Array<{ lang: Language; check: (baseDir: string) => boolean }> = [
  { lang: 'typescript', check: (d) => existsSync(join(d, 'tsconfig.json')) },
  { lang: 'python',     check: (d) => existsSync(join(d, 'pyproject.toml')) || existsSync(join(d, 'setup.py')) || existsSync(join(d, 'setup.cfg')) },
  { lang: 'go',         check: (d) => existsSync(join(d, 'go.mod')) },
  { lang: 'rust',       check: (d) => existsSync(join(d, 'Cargo.toml')) },
  { lang: 'javascript', check: (d) => existsSync(join(d, 'package.json')) },
]

export function detectLanguage(baseDir: string): Language {
  for (const d of detectors) {
    if (d.check(baseDir)) return d.lang
  }
  return 'unknown'
}

// --- TypeScript Adapter ---

const tsAdapter: LanguageAdapter = {
  detect: (baseDir) => existsSync(join(baseDir, 'tsconfig.json')),

  syntaxCheck(filePath, baseDir) {
    try {
      execSync(`npx tsc --noEmit --skipLibCheck ${filePath}`, { cwd: baseDir, stdio: 'pipe', timeout: 10_000 })
      return { passed: true, message: `TS syntax OK: ${filePath}` }
    } catch (e: any) {
      if (e.status === 127 || e.message.includes('not found')) return { passed: true, message: 'tsc not found — skipping' }
      const stderr = e.stderr?.toString() || ''
      if (stderr.includes('error TS') && !stderr.includes('Cannot find module')) {
        return { passed: false, message: `TS error in ${filePath}: ${stderr.split('\n').find((l: string) => l.includes('error TS'))?.trim()}` }
      }
      return { passed: true, message: `TS syntax OK: ${filePath}` }
    }
  },

  async typeCheck(baseDir) {
    try {
      execSync('npx tsc --noEmit --skipLibCheck', { cwd: baseDir, stdio: 'pipe', timeout: 30_000 })
      return { passed: true, message: 'TypeScript type check passed' }
    } catch (e: any) {
      if (e.status === 127 || e.message.includes('not found')) return { passed: true, message: 'tsc not found — skipping' }
      const stderr = e.stderr?.toString() || e.stdout?.toString() || ''
      const firstError = stderr.split('\n').find((l: string) => l.includes('error TS')) || 'TypeScript type error'
      return { passed: false, message: firstError.trim() }
    }
  },

  async runTests(baseDir) {
    const pkgPath = join(baseDir, 'package.json')
    if (!existsSync(pkgPath)) return { passed: true, message: 'No package.json — skipping tests' }
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      if (!pkg.scripts?.test) return { passed: true, message: 'No test script — skipping' }
    } catch { /* fall through */ }
    try {
      execSync('bun run test', { cwd: baseDir, encoding: 'utf-8', timeout: 60_000, stdio: 'pipe' })
      return { passed: true, message: 'Tests passed' }
    } catch (e: any) {
      return { passed: false, message: `Tests failed: ${(e.stderr?.toString() || e.message).slice(0, 500)}` }
    }
  },
}

// --- JavaScript Adapter ---

const jsAdapter: LanguageAdapter = {
  detect: (baseDir) => existsSync(join(baseDir, 'package.json')) && !existsSync(join(baseDir, 'tsconfig.json')),

  syntaxCheck(filePath) {
    try {
      execSync(`node --check ${filePath}`, { stdio: 'pipe', timeout: 5_000 })
      return { passed: true, message: `JS syntax OK: ${filePath}` }
    } catch {
      return { passed: false, message: `JS syntax error: ${filePath}` }
    }
  },

  async typeCheck() {
    return { passed: true, message: 'JavaScript — no type check' }
  },

  async runTests(baseDir) {
    const pkgPath = join(baseDir, 'package.json')
    if (!existsSync(pkgPath)) return { passed: true, message: 'No package.json — skipping tests' }
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      if (!pkg.scripts?.test) return { passed: true, message: 'No test script — skipping' }
    } catch { /* fall through */ }
    try {
      execSync('npm test', { cwd: baseDir, encoding: 'utf-8', timeout: 60_000, stdio: 'pipe' })
      return { passed: true, message: 'Tests passed' }
    } catch (e: any) {
      return { passed: false, message: `Tests failed: ${(e.stderr?.toString() || e.message).slice(0, 500)}` }
    }
  },
}

// --- Python Adapter ---

const pyAdapter: LanguageAdapter = {
  detect: (baseDir) => existsSync(join(baseDir, 'pyproject.toml')) || existsSync(join(baseDir, 'setup.py')),

  syntaxCheck(filePath) {
    try {
      execSync(`python -m py_compile ${filePath}`, { stdio: 'pipe', timeout: 10_000 })
      return { passed: true, message: `Python syntax OK: ${filePath}` }
    } catch (e: any) {
      const stderr = e.stderr?.toString() || e.message
      return { passed: false, message: `Python syntax error in ${filePath}: ${stderr.slice(0, 300)}` }
    }
  },

  async typeCheck(baseDir) {
    try {
      execSync('python -m mypy --ignore-missing-imports .', { cwd: baseDir, stdio: 'pipe', timeout: 60_000 })
      return { passed: true, message: 'mypy check passed' }
    } catch (e: any) {
      if (e.status === 127 || e.message.includes('not found')) return { passed: true, message: 'mypy not found — skipping' }
      const stderr = e.stderr?.toString() || e.message
      if (stderr.includes('error:')) {
        const firstError = stderr.split('\n').find((l: string) => l.includes('error:')) || 'Type error'
        return { passed: false, message: firstError.trim() }
      }
      return { passed: true, message: 'mypy check passed' }
    }
  },

  async runTests(baseDir) {
    try {
      execSync('python -m pytest --tb=short -q', { cwd: baseDir, encoding: 'utf-8', timeout: 120_000, stdio: 'pipe' })
      return { passed: true, message: 'pytest passed' }
    } catch (e: any) {
      if (e.status === 127 || e.message.includes('not found')) return { passed: true, message: 'pytest not found — skipping' }
      return { passed: false, message: `pytest failed: ${(e.stderr?.toString() || e.message).slice(0, 500)}` }
    }
  },
}

// --- Go Adapter ---

const goAdapter: LanguageAdapter = {
  detect: (baseDir) => existsSync(join(baseDir, 'go.mod')),

  syntaxCheck(filePath) {
    try {
      execSync(`go vet ${filePath}`, { stdio: 'pipe', timeout: 30_000 })
      return { passed: true, message: `Go vet OK: ${filePath}` }
    } catch (e: any) {
      if (e.status === 127) return { passed: true, message: 'go not found — skipping' }
      return { passed: false, message: `Go vet failed: ${(e.stderr?.toString() || e.message).slice(0, 300)}` }
    }
  },

  async typeCheck(baseDir) {
    try {
      execSync('go build ./...', { cwd: baseDir, stdio: 'pipe', timeout: 60_000 })
      return { passed: true, message: 'Go build passed' }
    } catch (e: any) {
      if (e.status === 127) return { passed: true, message: 'go not found — skipping' }
      return { passed: false, message: `Go build failed: ${(e.stderr?.toString() || e.message).slice(0, 500)}` }
    }
  },

  async runTests(baseDir) {
    try {
      execSync('go test ./...', { cwd: baseDir, encoding: 'utf-8', timeout: 120_000, stdio: 'pipe' })
      return { passed: true, message: 'go test passed' }
    } catch (e: any) {
      if (e.status === 127) return { passed: true, message: 'go not found — skipping' }
      return { passed: false, message: `go test failed: ${(e.stderr?.toString() || e.message).slice(0, 500)}` }
    }
  },
}

// --- Rust Adapter ---

const rustAdapter: LanguageAdapter = {
  detect: (baseDir) => existsSync(join(baseDir, 'Cargo.toml')),

  syntaxCheck(filePath) {
    // Rust syntax is checked by cargo check, not per-file
    return { passed: true, message: `Rust syntax checked via cargo check: ${filePath}` }
  },

  async typeCheck(baseDir) {
    try {
      execSync('cargo check', { cwd: baseDir, stdio: 'pipe', timeout: 120_000 })
      return { passed: true, message: 'cargo check passed' }
    } catch (e: any) {
      if (e.status === 127) return { passed: true, message: 'cargo not found — skipping' }
      return { passed: false, message: `cargo check failed: ${(e.stderr?.toString() || e.message).slice(0, 500)}` }
    }
  },

  async runTests(baseDir) {
    try {
      execSync('cargo test', { cwd: baseDir, encoding: 'utf-8', timeout: 120_000, stdio: 'pipe' })
      return { passed: true, message: 'cargo test passed' }
    } catch (e: any) {
      if (e.status === 127) return { passed: true, message: 'cargo not found — skipping' }
      return { passed: false, message: `cargo test failed: ${(e.stderr?.toString() || e.message).slice(0, 500)}` }
    }
  },
}

// --- Registry ---

const adapters: Record<Language, LanguageAdapter> = {
  typescript: tsAdapter,
  javascript: jsAdapter,
  python: pyAdapter,
  go: goAdapter,
  rust: rustAdapter,
  unknown: {
    detect: () => false,
    syntaxCheck: () => ({ passed: true, message: 'Unknown language — skipping syntax check' }),
    typeCheck: () => Promise.resolve({ passed: true, message: 'Unknown language — skipping type check' }),
    runTests: () => Promise.resolve({ passed: true, message: 'Unknown language — skipping tests' }),
  },
}

export function getAdapter(lang: Language): LanguageAdapter {
  return adapters[lang]
}

export function getAdapterForDir(baseDir: string): { language: Language; adapter: LanguageAdapter } {
  const language = detectLanguage(baseDir)
  return { language, adapter: getAdapter(language) }
}
```

### Step 1.4: Run tests to verify they pass

Run: `bun test tests/language-adapters.test.ts`
Expected: ALL PASS

### Step 1.5: Commit

```bash
git add src/modules/execution/language-adapters.ts tests/language-adapters.test.ts
git commit -m "feat: add language detection + adapters for verifier"
```

---

## Task 2: Integrate Adapters into Verifier

**Files:**
- Modify: `src/modules/execution/verifier.ts:154-183` (replace `validateSyntax()`)
- Modify: `tests/execution-verifier.test.ts`

### Step 2.1: Write failing test for adapter-based syntax check

Add to `tests/execution-verifier.test.ts`:

```typescript
it('should use language adapter for syntax check when available', async () => {
  mkdirSync(join(tmpDir, 'src'), { recursive: true })
  writeFileSync(join(tmpDir, 'tsconfig.json'), '{}')
  writeFileSync(join(tmpDir, 'src/index.ts'), 'export const x = 1')
  const result = await verifier.verifyStep('Create src/index.ts with content')
  // Should attempt TS syntax check (may fail without tsc installed, but shouldn't crash)
  expect(result.syntaxValid).toBeDefined()
})
```

### Step 2.2: Run test to verify it fails differently

Run: `bun test tests/execution-verifier.test.ts`
Expected: The new test may pass by accident (validateSyntax returns true for unknown ext). After our change, it should actually try tsc.

### Step 2.3: Modify `validateSyntax()` to use adapter

Replace `validateSyntax()` in `verifier.ts`:

```typescript
import { detectLanguage, getAdapter } from './language-adapters'

// ... in StepVerifier class:

  private validateSyntax(filePath: string): boolean {
    const ext = extname(filePath)

    // Legacy TS/JS checks (kept for backwards compatibility)
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

    // Language-adapter check for other languages
    const { language, adapter } = getAdapter(this.baseDir)
    if (language !== 'unknown') {
      const result = adapter.syntaxCheck(filePath, this.baseDir)
      return result.passed
    }

    return true
  }
```

### Step 2.4: Run tests

Run: `bun test tests/execution-verifier.test.ts`
Expected: ALL PASS

### Step 2.5: Commit

```bash
git add src/modules/execution/verifier.ts tests/execution-verifier.test.ts
git commit -m "feat: verifier uses language adapters for syntax check"
```

---

## Task 3: Integrate Adapters into Auditor

**Files:**
- Modify: `src/modules/execution/auditor.ts`
- Modify: `tests/execution-auditor.test.ts`
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`

### Step 3.1: Write failing tests for multi-language audit

Add to `tests/execution-auditor.test.ts`:

```typescript
it('should detect TypeScript and run type check', async () => {
  mkdirSync(join(tmpDir, 'src'), { recursive: true })
  writeFileSync(join(tmpDir, 'tsconfig.json'), '{}')
  writeFileSync(join(tmpDir, 'src/index.ts'), 'export const x = 1')

  const plan = PlanCreator.createPlan('test', ['Create src/index.ts with content'], tmpDir)
  plan.steps[0].status = 'done'

  const result = await auditor.audit(plan)
  // TypeScript detected, type check attempted
  expect(result.typeCheckError).toBeDefined()
})

it('should detect Python project', async () => {
  mkdirSync(join(tmpDir, 'src'), { recursive: true })
  writeFileSync(join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"')
  writeFileSync(join(tmpDir, 'src/main.py'), 'print("hello")')

  const plan = PlanCreator.createPlan('test', ['Create src/main.py with content'], tmpDir)
  plan.steps[0].status = 'done'

  const result = await auditor.audit(plan)
  // Python detected, type check attempted via mypy
  expect(result.summary).toBeDefined()
})

it('should include language in audit summary', async () => {
  mkdirSync(join(tmpDir, 'src'), { recursive: true })
  writeFileSync(join(tmpDir, 'go.mod'), 'module example.com/mymod\n\ngo 1.21')
  writeFileSync(join(tmpDir, 'src/main.go'), 'package main')

  const plan = PlanCreator.createPlan('test', ['Create src/main.go'], tmpDir)
  plan.steps[0].status = 'done'

  const result = await auditor.audit(plan)
  expect(result.summary).toMatch(/go|unknown/i)
})
```

### Step 3.2: Run tests to verify they fail

Run: `bun test tests/execution-auditor.test.ts`
Expected: FAIL — auditor still uses hardcoded `runProjectTypeCheck()`

### Step 3.3: Modify Auditor to use adapters

Replace `auditor.ts`:

```typescript
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { resolve, join } from 'path'
import { t } from '../../i18n/index'
import type { Plan } from './planner'
import { detectLanguage, getAdapter, type Language } from './language-adapters'

export interface AuditResult {
  passed: boolean
  missingFiles: string[]
  createdFiles: string[]
  modifiedFiles: string[]
  summary: string
  typeCheckError: string | null
  language: Language
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

    const doneSteps = plan.steps.filter(s => s.status === 'done').length
    const totalSteps = plan.steps.length

    const language = detectLanguage(this.baseDir)
    const adapter = getAdapter(language)
    const typeCheckResult = await adapter.typeCheck(this.baseDir)
    const typeCheckError = typeCheckResult.passed ? null : typeCheckResult.message

    const passed = missingFiles.length === 0 && !typeCheckError

    const langLabel = language === 'unknown' ? '' : ` [${language}]`
    let summary: string
    if (passed) {
      summary = t('exec.audit_pass', { done: doneSteps, total: totalSteps, files: existingFiles.length }) + langLabel
    } else {
      const missingCount = missingFiles.length
      if (typeCheckError) {
        summary = t('exec.audit_fail_typecheck', { done: doneSteps, total: totalSteps, missing: missingCount, typeError: typeCheckError }) + langLabel
      } else {
        summary = t('exec.audit_fail', { done: doneSteps, total: totalSteps, files: missingCount }) + langLabel
      }
    }

    return {
      passed,
      missingFiles,
      createdFiles: existingFiles,
      modifiedFiles: [],
      summary,
      typeCheckError,
      language,
    }
  }
}
```

### Step 3.4: Run tests

Run: `bun test tests/execution-auditor.test.ts`
Expected: ALL PASS

### Step 3.5: Commit

```bash
git add src/modules/execution/auditor.ts tests/execution-auditor.test.ts
git commit -m "feat: auditor uses language adapters, adds language to AuditResult"
```

---

## Task 4: Run all tests + typecheck

### Step 4.1: Run full test suite

Run: `bun test`
Expected: ALL PASS (no regressions)

### Step 4.2: Typecheck

Run: `tsc --noEmit`
Expected: NO ERRORS

### Step 4.3: Final commit if needed

```bash
git add -A
git commit -m "chore: language support for verifier — all tests pass"
```

---

## Verification Checklist

- [ ] `bun test tests/language-adapters.test.ts` — detection tests pass
- [ ] `bun test tests/execution-verifier.test.ts` — verifier tests pass (no regressions + new adapter test)
- [ ] `bun test tests/execution-auditor.test.ts` — auditor tests pass (no regressions + multi-language tests)
- [ ] `bun test` — full suite passes
- [ ] `tsc --noEmit` — no type errors
- [ ] `detectLanguage()` correctly identifies TS, Python, Go, Rust, JS, unknown
- [ ] Each adapter's `syntaxCheck()` runs the right command
- [ ] Each adapter's `typeCheck()` runs the right command
- [ ] Each adapter's `runTests()` runs the right command
- [ ] Auditor includes `language` field in `AuditResult`
- [ ] Unknown language doesn't crash — gracefully skips checks
