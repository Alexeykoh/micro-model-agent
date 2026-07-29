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

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this._connected || !this.process) {
      throw new Error('Not connected to MCP server')
    }

    return new Promise((resolve, reject) => {
      const request = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      }

      const requestStr = JSON.stringify(request) + '\n'
      
      this.process!.stdin!.write(requestStr)
      
      let responseData = ''
      
      const onData = (data: Buffer) => {
        responseData += data.toString()
        
        if (responseData.includes('\n')) {
          this.process!.stdout!.off('data', onData)
          
          try {
            const lines = responseData.split('\n').filter(l => l.trim())
            for (const line of lines) {
              const response = JSON.parse(line)
              if (response.id === request.id) {
                if (response.error) {
                  reject(new Error(response.error.message))
                } else {
                  resolve(response.result)
                }
                return
              }
            }
            reject(new Error('No matching response found'))
          } catch (e: any) {
            reject(new Error(`Parse error: ${e.message}`))
          }
        }
      }
      
      this.process!.stdout!.on('data', onData)
      
      setTimeout(() => {
        this.process!.stdout!.off('data', onData)
        reject(new Error('MCP call timeout'))
      }, 30000)
    })
  }
}
