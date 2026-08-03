import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SkillsLoader } from '../src/modules/skills/loader'
import { SkillsMatcher } from '../src/modules/skills/matcher'
import { SkillsModule } from '../src/modules/skills/module'
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

describe('SkillsModule.getSystemPromptBlock', () => {
  const makeSkills = () => [
    { name: 'git-expert', description: 'Git branching, merge conflicts, rebasing', keywords: ['git'], content: 'git skill content' },
    { name: 'ts-expert', description: 'TypeScript type system, generics', keywords: ['typescript'], content: 'ts skill content' },
  ]

  it('should include available skills in prompt so agent knows what to load', () => {
    const matcher = new SkillsMatcher()
    const mod = new SkillsModule(makeSkills() as any, matcher, 1000)
    const block = mod.getSystemPromptBlock()

    expect(block).not.toBeNull()
    expect(block!.content).toContain('[Available Skills]')
    expect(block!.content).toContain('git-expert')
    expect(block!.content).toContain('ts-expert')
    expect(block!.content).toContain('load_skill')
  })

  it('should include loaded skills section after loading', () => {
    const matcher = new SkillsMatcher()
    const mod = new SkillsModule(makeSkills() as any, matcher, 1000)
    mod.loadByName('git-expert')
    const block = mod.getSystemPromptBlock()

    expect(block).not.toBeNull()
    expect(block!.content).toContain('[Available Skills]')
    expect(block!.content).toContain('[Loaded Skills]')
    expect(block!.content).toContain('git-expert')
  })

  it('should return null when no skills available', () => {
    const matcher = new SkillsMatcher()
    const mod = new SkillsModule([], matcher, 1000)
    const block = mod.getSystemPromptBlock()
    expect(block).toBeNull()
  })
})

describe('SkillsModule auto-load plugin', () => {
  const makeSkills = () => [
    { name: 'git-expert', description: 'Git branching, merge conflicts, rebasing', keywords: ['git', 'branch', 'merge'], content: 'git skill content here' },
    { name: 'ts-expert', description: 'TypeScript type system, generics', keywords: ['typescript', 'generics'], content: 'ts skill content here' },
  ]

  const makeContextManager = () => {
    const messages: { role: string; content: string }[] = []
    return {
      messages,
      addMessage: (msg: { role: string; content: string }) => messages.push(msg),
    }
  }

  it('should NOT auto-load matching skill on onBeforeThink', () => {
    const matcher = new SkillsMatcher()
    const mod = new SkillsModule(makeSkills() as any, matcher, 1000)
    const plugin = mod.getPlugin()

    expect(mod.getLoaded()).toHaveLength(0)

    plugin.onBeforeThink!({ lastUserMessage: 'how to resolve git merge conflict?' })

    expect(mod.getLoaded()).toHaveLength(0)
  })

  it('should NOT add skill content to contextManager on onBeforeThink', () => {
    const matcher = new SkillsMatcher()
    const mod = new SkillsModule(makeSkills() as any, matcher, 1000)
    const plugin = mod.getPlugin()
    const ctx = makeContextManager()

    plugin.onBeforeThink!({ lastUserMessage: 'git merge conflict', contextManager: ctx })

    expect(ctx.messages).toHaveLength(0)
    expect(mod.getLoaded()).toHaveLength(0)
  })

  it('should not load skill if no match', () => {
    const matcher = new SkillsMatcher()
    const mod = new SkillsModule(makeSkills() as any, matcher, 1000)
    const plugin = mod.getPlugin()

    plugin.onBeforeThink!({ lastUserMessage: 'what is the weather today?' })

    expect(mod.getLoaded()).toHaveLength(0)
  })

  it('should not auto-load same skill twice (no-op onBeforeThink)', () => {
    const matcher = new SkillsMatcher()
    const mod = new SkillsModule(makeSkills() as any, matcher, 1000)
    const plugin = mod.getPlugin()
    const ctx = makeContextManager()

    plugin.onBeforeThink!({ lastUserMessage: 'git branch question', contextManager: ctx })
    plugin.onBeforeThink!({ lastUserMessage: 'git merge question', contextManager: ctx })

    expect(mod.getLoaded()).toHaveLength(0)
    expect(ctx.messages).toHaveLength(0)
  })

  it('should not load if budget exceeded', () => {
    const matcher = new SkillsMatcher()
    const mod = new SkillsModule(makeSkills() as any, matcher, 5)
    const plugin = mod.getPlugin()

    plugin.onBeforeThink!({ lastUserMessage: 'git merge conflict' })

    expect(mod.getLoaded()).toHaveLength(0)
  })

  it('should allow loadByName even after onBeforeThink (no auto-load)', () => {
    const matcher = new SkillsMatcher()
    const mod = new SkillsModule(makeSkills() as any, matcher, 1000)
    const plugin = mod.getPlugin()

    plugin.onBeforeThink!({ lastUserMessage: 'git merge conflict' })
    expect(mod.getLoaded()).toHaveLength(0)

    const result = mod.loadByName('git-expert')
    expect(result.success).toBe(true)
    expect(mod.getLoaded()).toHaveLength(1)
  })
})
