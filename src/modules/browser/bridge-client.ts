import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface, type Interface as ReadlineInterface } from 'readline'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { BrowserDriver } from './driver'
import type { ConsoleEntry, NetworkErrorEntry } from './types'
import { ConsoleBuffer } from './session'
import type { StoredCookie } from './cookie-store'

const BRIDGE_REQUEST_TIMEOUT_MS = 30000

interface BridgeResponse {
  id: number
  ok: boolean
  error?: string
  data?: any
  console?: ConsoleEntry[]
  network?: NetworkErrorEntry[]
}

function bridgeScriptPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'bridge-server.mjs')
}

export class BridgeDriver implements BrowserDriver {
  private proc: ChildProcessWithoutNullStreams | null = null
  private rl: ReadlineInterface | null = null
  private pending = new Map<number, (resp: BridgeResponse) => void>()
  private lastStderr: string[] = []
  private nextId = 1
  private lastUrl = ''
  private console = new ConsoleBuffer(500)
  private network: NetworkErrorEntry[] = []
  private maxConsoleLineChars: number

  constructor(opts: { maxConsoleLineChars?: number } = {}) {
    this.maxConsoleLineChars = opts.maxConsoleLineChars ?? 400
  }

  private async send(cmd: string, params: Record<string, unknown> = {}, retried = false): Promise<BridgeResponse> {
    if (!this.proc || !this.rl) {
      if (retried || cmd === 'close') throw new Error('Bridge is not running')
      this.spawnBridge()
      return this.send(cmd, params, true)
    }
    const id = this.nextId++
    const response = await new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Bridge timeout waiting for "${cmd}"`))
      }, BRIDGE_REQUEST_TIMEOUT_MS)
      this.pending.set(id, (resp) => {
        clearTimeout(timer)
        resolve(resp)
      })
      this.proc!.stdin.write(JSON.stringify({ id, cmd, params }) + '\n')
    })
    this.drainEvents(response)
    if (!response.ok) throw new Error(response.error || `Bridge command failed: ${cmd}`)
    return response
  }

  private drainEvents(resp: BridgeResponse): void {
    if (Array.isArray(resp.console)) {
      for (const entry of resp.console) {
        this.console.add(entry.type, entry.text)
      }
    }
    if (Array.isArray(resp.network)) {
      for (const err of resp.network) this.network.push(err)
    }
    if (resp.data && typeof resp.data.url === 'string') {
      this.lastUrl = resp.data.url
    }
  }

  async launch(cfg: { headless: boolean; viewport: { width: number; height: number }; timeoutMs: number }): Promise<void> {
    this.spawnBridge()
    await this.send('launch', {
      headless: cfg.headless,
      viewport: cfg.viewport,
      timeoutMs: cfg.timeoutMs,
      maxConsoleLineChars: this.maxConsoleLineChars,
    })
  }

  private spawnBridge(): void {
    const script = bridgeScriptPath()
    const proc = spawn('node', [script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.proc = proc
    this.lastStderr = []
    proc.stderr.on('data', (chunk: Buffer) => {
      this.lastStderr = [...this.lastStderr.slice(-4), chunk.toString()]
    })
    const rl = createInterface({ input: proc.stdout })
    this.rl = rl
    rl.on('line', (line) => {
      let resp: BridgeResponse
      try {
        resp = JSON.parse(line)
      } catch {
        return
      }
      const resolver = this.pending.get(resp.id)
      if (resolver) {
        this.pending.delete(resp.id)
        resolver(resp)
      }
    })
    proc.on('error', (err) => {
      if (this.proc !== proc) return // stale child — a newer bridge is alive
      this.failPending(`Bridge process failed to start: ${err.message}`)
      this.proc = null
      this.rl = null
    })
    proc.on('exit', (code) => {
      if (this.proc !== proc) return // stale child — a newer bridge is alive
      const stderrTail = this.lastStderr.join('').trim()
      this.failPending(
        stderrTail
          ? `Bridge process exited (code ${code}): ${stderrTail.slice(0, 300)}`
          : `Bridge process exited (code ${code})`,
      )
      this.proc = null
      this.rl = null
    })
  }

  private failPending(error: string): void {
    for (const [, resolver] of this.pending) {
      resolver({ id: -1, ok: false, error })
    }
    this.pending.clear()
  }

  async goto(url: string, timeoutMs: number): Promise<void> {
    await this.send('goto', { url, timeoutMs })
  }

  async evaluate(js: string): Promise<unknown> {
    const resp = await this.send('evaluate', { js })
    return resp.data?.result
  }

  async content(): Promise<string> {
    const resp = await this.send('content')
    return String(resp.data?.html ?? '')
  }

  async title(): Promise<string> {
    const resp = await this.send('title')
    return String(resp.data?.title ?? '')
  }

  url(): string {
    return this.lastUrl
  }

  async waitForLoad(timeoutMs: number): Promise<void> {
    await this.send('waitLoad', { timeoutMs })
  }

  async screenshot(): Promise<Buffer> {
    const resp = await this.send('screenshot')
    return Buffer.from(String(resp.data?.base64 ?? ''), 'base64')
  }

  async cookies(): Promise<StoredCookie[]> {
    const resp = await this.send('cookies')
    return (resp.data?.cookies ?? []) as StoredCookie[]
  }

  async addCookies(cookies: StoredCookie[]): Promise<void> {
    await this.send('setCookies', { cookies })
  }

  async goBack(timeoutMs: number): Promise<void> {
    await this.send('back', { timeoutMs })
  }

  async goForward(timeoutMs: number): Promise<void> {
    await this.send('forward', { timeoutMs })
  }

  resetEventLog(): void {
    this.console.clear()
    this.network = []
  }

  getConsole(): ConsoleEntry[] {
    return this.console.getAll()
  }

  getNetworkErrors(): NetworkErrorEntry[] {
    return this.network.slice(-15)
  }

  async close(): Promise<void> {
    try {
      if (this.proc) await this.send('close')
    } catch {
      // ignore — we're shutting down
    }
    this.dispose()
  }

  dispose(): void {
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
    if (this.rl) {
      this.rl.close()
      this.rl = null
    }
  }
}