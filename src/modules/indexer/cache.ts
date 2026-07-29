import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import type { IndexResult } from './walker'

export class IndexCache {
  private cachePath: string
  private cache: IndexResult | null = null

  constructor(cacheDir: string) {
    this.cachePath = join(cacheDir, 'index-cache.json')
  }

  load(): IndexResult | null {
    if (this.cache) return this.cache
    if (!existsSync(this.cachePath)) return null
    try {
      this.cache = JSON.parse(readFileSync(this.cachePath, 'utf-8'))
      return this.cache
    } catch { return null }
  }

  save(result: IndexResult): void {
    this.cache = result
    const dir = join(this.cachePath, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.cachePath, JSON.stringify(result), 'utf-8')
  }

  invalidate(): void {
    this.cache = null
    if (existsSync(this.cachePath)) {
      try { rmSync(this.cachePath) } catch { /* ignore */ }
    }
  }
}
