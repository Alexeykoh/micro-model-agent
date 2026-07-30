import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const MEMORY_FILES = ['conventions', 'decisions', 'errors']

export interface SearchResult {
  file: string
  match: string
}

export class MemorySearch {
  private memoryDir: string

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir
  }

  query(query: string): SearchResult[] {
    const results: SearchResult[] = []
    const lowerQuery = query.toLowerCase()

    for (const name of MEMORY_FILES) {
      const path = join(this.memoryDir, `${name}.md`)
      if (!existsSync(path)) continue

      const content = readFileSync(path, 'utf-8')
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
