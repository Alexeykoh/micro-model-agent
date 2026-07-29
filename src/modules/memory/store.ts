import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

const MEMORY_FILES = ['conventions', 'decisions', 'errors']

export class MemoryStore {
  private memoryDir: string

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir
    this.ensureDir()
    for (const name of MEMORY_FILES) {
      const path = join(this.memoryDir, `${name}.md`)
      if (!existsSync(path)) {
        writeFileSync(path, `# ${name.charAt(0).toUpperCase() + name.slice(1)}\n\n`, 'utf-8')
      }
    }
  }

  private ensureDir(): void {
    if (!existsSync(this.memoryDir)) {
      mkdirSync(this.memoryDir, { recursive: true })
    }
  }

  read(name: string): string {
    const path = join(this.memoryDir, `${name}.md`)
    if (!existsSync(path)) return ''
    return readFileSync(path, 'utf-8')
  }

  append(name: string, entry: string): void {
    const path = join(this.memoryDir, `${name}.md`)
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const formatted = `- **${timestamp}** — ${entry}\n`
    appendFileSync(path, formatted, 'utf-8')
  }

  search(query: string): Array<{ file: string; match: string }> {
    const results: Array<{ file: string; match: string }> = []
    const lowerQuery = query.toLowerCase()

    for (const name of MEMORY_FILES) {
      const content = this.read(name)
      const lines = content.split('\n')
      for (const line of lines) {
        if (line.toLowerCase().includes(lowerQuery)) {
          results.push({ file: name, match: line.trim() })
        }
      }
    }

    return results
  }
}
