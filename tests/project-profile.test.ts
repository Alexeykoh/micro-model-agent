import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildProjectProfileLine,
  readProjectProfile,
  formatProjectProfile,
  detectManifest,
} from '../src/modules/indexer/project-profile'

describe('project-profile', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-prof-'))
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
  })

  it('detects package.json as the manifest', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{"name":"x"}')
    expect(detectManifest(tmpDir)).toBe('package.json')
  })

  it('returns null when no manifest exists', () => {
    expect(detectManifest(tmpDir)).toBeNull()
    expect(buildProjectProfileLine(tmpDir)).toBeNull()
  })

  it('reads package.json name, deps, devDeps, scripts', () => {
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'bicycle-shop',
        scripts: { dev: 'vite', build: 'tsc -b && vite build' },
        dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
        devDependencies: { vite: '^6.0.1', typescript: '~5.6.2' },
      }),
    )
    const profile = readProjectProfile(tmpDir)!
    expect(profile.name).toBe('bicycle-shop')
    expect(profile.runtime).toBe('node')
    expect(profile.deps).toEqual(['react', 'react-dom'])
    expect(profile.devDeps).toEqual(['vite', 'typescript'])
    expect(profile.scripts['dev']).toBe('vite')
  })

  it('caps dependency lists in the formatted line', () => {
    const deps: Record<string, string> = {}
    for (let i = 0; i < 8; i++) deps[`pkg${i}`] = '1.0.0'
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'big', dependencies: deps }),
    )
    const line = buildProjectProfileLine(tmpDir)!
    expect((line.match(/pkg\d/g) || []).length).toBeLessThanOrEqual(5)
  })

  it('is best-effort on malformed package.json', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{ not valid json')
    expect(buildProjectProfileLine(tmpDir)).toBeNull()
  })

  it('reads pyproject.toml', () => {
    writeFileSync(
      join(tmpDir, 'pyproject.toml'),
      '[project]\nname = "mypkg"\ndependencies = ["requests>=2.0", "flask"]',
    )
    const profile = readProjectProfile(tmpDir)!
    expect(profile.runtime).toBe('python')
    expect(profile.deps).toEqual(['requests', 'flask'])
  })

  it('reads Cargo.toml', () => {
    writeFileSync(
      join(tmpDir, 'Cargo.toml'),
      '[package]\nname = "mycrate"\n[dependencies]\nserde = "1.0"\ntokio = { version = "1" }',
    )
    const profile = readProjectProfile(tmpDir)!
    expect(profile.runtime).toBe('rust')
    expect(profile.deps).toContain('serde')
    expect(profile.deps).toContain('tokio')
  })

  it('reads go.mod', () => {
    writeFileSync(
      join(tmpDir, 'go.mod'),
      'module example.com/mymod\n\ngo 1.21\n\nrequire (\n\tgithub.com/foo/bar v1.0.0\n\tgolang.org/x/sync v0.1.0\n)\n',
    )
    const profile = readProjectProfile(tmpDir)!
    expect(profile.runtime).toBe('go')
    expect(profile.deps).toEqual(['github.com/foo/bar', 'golang.org/x/sync'])
  })

  it('reads requirements.txt', () => {
    writeFileSync(
      join(tmpDir, 'requirements.txt'),
      'requests==2.31.0\nflask>=3.0\n',
    )
    const profile = readProjectProfile(tmpDir)!
    expect(profile.runtime).toBe('python')
    expect(profile.deps).toEqual(['requests', 'flask'])
  })

  it('formats a compact stack line', () => {
    const line = formatProjectProfile({
      name: 'bicycle-shop',
      runtime: 'node',
      deps: ['react', 'react-dom'],
      devDeps: ['vite'],
      scripts: { dev: 'vite' },
    })
    expect(line).toContain('bicycle-shop')
    expect(line).toContain('react')
    expect(line.length).toBeLessThan(200)
  })
})
