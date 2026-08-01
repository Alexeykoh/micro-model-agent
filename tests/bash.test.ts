import { describe, it, expect, afterAll } from 'vitest'
import { writeFileSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bashTool } from '../src/tools/bash'
import { processRegistry } from '../src/modules/processes'

const tmpProject = mkdtempSync(join(tmpdir(), 'mma-bash-'))
const idleScript = join(tmpProject, 'idle.js')
writeFileSync(idleScript, `setInterval(() => {}, 1000);`, 'utf-8')
writeFileSync(
  join(tmpProject, 'package.json'),
  JSON.stringify({ name: 'mma-bash-test', scripts: { dev: `node ${idleScript}` } }),
  'utf-8',
)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterAll(async () => {
  processRegistry.killAll()
  await sleep(200)
  try {
    rmSync(tmpProject, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function makeCtx(extra: Record<string, unknown> = {}) {
  return {
    baseDir: process.cwd(),
    config: {},
    logger: { info: () => {}, error: () => {} },
    ...extra,
  } as any
}

describe('bash', () => {
  it('should execute a command', async () => {
    const ctx = makeCtx()
    const result = await bashTool.handler(ctx, { command: 'echo hello' })
    expect(result.success).toBe(true)
    expect(result.output.trim()).toBe('hello')
  })

  it('should handle command failure', async () => {
    const ctx = makeCtx()
    const result = await bashTool.handler(ctx, { command: 'exit 1' })
    expect(result.success).toBe(false)
  })

  it('should start long-running commands in background and return a process id', async () => {
    const ctx = makeCtx({ sessionId: 'bash-ses' })
    const result = await bashTool.handler(ctx, {
      command: `node ${idleScript}`,
      background: true,
    })
    expect(result.success).toBe(true)
    expect(result.output).toContain('proc_')
    expect(result.output).toContain('PID')
    expect(result.output).toContain('process_log')

    const idMatch = result.output.match(/proc_\d+_\d+/)
    expect(idMatch).not.toBeNull()
    const entry = processRegistry.get(idMatch![0])
    expect(entry).toBeDefined()
    expect(entry!.sessionId).toBe('bash-ses')

    processRegistry.kill(entry!.id)
    await sleep(200)
    expect(processRegistry.get(entry!.id)?.status).toBe('killed')
  })

  it('should auto-detect long-running commands', async () => {
    const ctx = makeCtx({ baseDir: tmpProject })
    const result = await bashTool.handler(ctx, { command: 'npm run dev' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('proc_')
    expect(result.output).toContain('Long-running')
  })

  it('should not auto-background one-shot commands', async () => {
    const ctx = makeCtx()
    const result = await bashTool.handler(ctx, { command: 'node -p 42' })
    expect(result.success).toBe(true)
    expect(result.output.trim()).toBe('42')
  })
})
