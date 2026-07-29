import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SkillsLoader } from '../src/modules/skills/loader'
import { SkillsMatcher } from '../src/modules/skills/matcher'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('SkillsLoader', () => {
  let tmpDir: string
  let loader: SkillsLoader

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-skills-'))
    loader = new SkillsLoader()
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
  })

  it('should load skill from YAML frontmatter file', () => {
    const skillContent = `---
name: typescript-expert
description: TypeScript type system expert
keywords: [typescript, generics, types]
---
Some skill content here`
    writeFileSync(join(tmpDir, 'typescript.md'), skillContent)
    const skills = loader.loadFromDir(tmpDir)
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('typescript-expert')
    expect(skills[0].keywords).toContain('typescript')
  })

  it('should skip files without frontmatter', () => {
    writeFileSync(join(tmpDir, 'plain.txt'), 'no frontmatter')
    const skills = loader.loadFromDir(tmpDir)
    expect(skills).toHaveLength(0)
  })
})

describe('SkillsMatcher', () => {
  it('should match skill by keyword overlap', () => {
    const skills = [
      { name: 'ts', description: 'TypeScript', keywords: ['typescript', 'generics'] },
      { name: 'git', description: 'Git', keywords: ['git', 'branch'] },
    ]
    const matcher = new SkillsMatcher()
    const matches = matcher.match('implement a generic TypeScript type', skills as any, 1)
    expect(matches).toHaveLength(1)
    expect(matches[0].name).toBe('ts')
  })

  it('should return empty when no keywords match', () => {
    const skills = [
      { name: 'docker', description: 'Docker', keywords: ['docker', 'container'] },
    ]
    const matcher = new SkillsMatcher()
    const matches = matcher.match('TypeScript generics', skills as any, 1)
    expect(matches).toHaveLength(0)
  })
})
