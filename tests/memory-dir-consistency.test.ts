// tests/memory-dir-consistency.test.ts
//
// Root cause (ses_mst2r0r5 post-mortem): the agent loop writes error rules to
// PROJECT memory (`join(baseDir, ".mma", "memory")` in core/agent.ts) while
// MemoryModule / remember / recall read GLOBAL memory (`~/.mma/memory`). The
// project `.mma/memory/errors.md` accumulated 2608 bytes of real lessons that
// never reached the system prompt — the agent repeated the same failures
// across sessions.
//
// Fix: a single MemoryStore instance injected into both MemoryModule and the
// agent loop (AgentDeps.memoryStore). This test pins the contract: whatever
// the loop records through the store must be visible in the module's system
// prompt block.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MemoryStore } from '../src/modules/memory/store'
import { MemoryModule } from '../src/modules/memory/module'

describe('memory single source of truth', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mma-memdir-'))
  })

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  it('MemoryModule accepts an injected MemoryStore and shares it', () => {
    const store = new MemoryStore(dir)
    const mod = new MemoryModule(store)
    expect(mod.getStore()).toBe(store)
  })

  it('errors recorded through the injected store surface in the prompt block', () => {
    // The agent loop records repeated tool failures via this same store.
    const store = new MemoryStore(dir)
    const mod = new MemoryModule(store)
    store.appendRule(
      'errors',
      'LSP spawn ENOENT',
      'npx .cmd shim without shell',
      'run through cmd.exe',
    )
    const block = mod.getSystemPromptBlock()
    expect(block).not.toBeNull()
    expect(block!.content).toContain('LSP spawn ENOENT')
    expect(block!.content).toContain('Memory errors')
  })

  it('prompt block includes .md memory even without preferences (M13)', () => {
    // Old behavior: getSystemPromptBlock() returned null unless preferences
    // existed, so errors.md/conventions.md never reached the prompt.
    const store = new MemoryStore(dir)
    const mod = new MemoryModule(store)
    store.append('conventions', 'Use forward slashes in paths on Windows')
    const block = mod.getSystemPromptBlock()
    expect(block).not.toBeNull()
    expect(block!.content).toContain('forward slashes')
  })

  it('prompt block stays null when memory is completely empty', () => {
    const store = new MemoryStore(dir)
    const mod = new MemoryModule(store)
    expect(mod.getSystemPromptBlock()).toBeNull()
  })

  it('caps the memory tail to the most recent entries', () => {
    const store = new MemoryStore(dir)
    const mod = new MemoryModule(store)
    for (let i = 1; i <= 10; i++) {
      store.append('errors', `old failure ${i}`)
    }
    const block = mod.getSystemPromptBlock()
    expect(block).not.toBeNull()
    expect(block!.content).not.toContain('old failure 1\n')
    expect(block!.content).toContain('old failure 10')
  })

  it('raw pre-existing .md files (legacy project memory) are readable via the same dir', () => {
    // Simulate the observed session: a project .mma/memory/errors.md already
    // written by an older MMA. Pointing the module at that dir must surface it.
    writeFileSync(
      join(dir, 'errors.md'),
      '# Errors\n\n- **2026-08-14** — **pattern:** Tool bash failed 3x\n',
      'utf-8',
    )
    const store = new MemoryStore(dir)
    const mod = new MemoryModule(store)
    const block = mod.getSystemPromptBlock()
    expect(block).not.toBeNull()
    expect(block!.content).toContain('Tool bash failed 3x')
  })
})
