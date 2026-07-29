import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { MemorySearch } from './search'

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
    const searchModule = new MemorySearch(this.memoryDir)
    return searchModule.query(query)
  }
}
