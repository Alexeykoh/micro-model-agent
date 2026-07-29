import { spawn, ChildProcess } from 'child_process'
import type { MCPServerConfig } from './registry'

export class MCPClient {
  readonly serverName: string
  private config: MCPServerConfig
  private process: ChildProcess | null = null
  private _connected = false

  constructor(config: MCPServerConfig) {
    this.config = config
    this.serverName = config.name
  }

  isConnected(): boolean {
    return this._connected
  }

  async connect(): Promise<void> {
    if (this._connected) return

    return new Promise((resolve, reject) => {
      const child = spawn(this.config.command, this.config.args, {
        env: { ...process.env, ...this.config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      child.on('error', (err) => {
        this._connected = false
        reject(err)
      })

      child.on('exit', (code) => {
        this._connected = false
        if (code !== 0) {
          reject(new Error(`MCP server exited with code ${code}`))
        }
      })

      child.on('spawn', () => {
        this._connected = true
        this.process = child
        resolve()
      })
    })
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill()
      this.process = null
    }
    this._connected = false
  }
}
