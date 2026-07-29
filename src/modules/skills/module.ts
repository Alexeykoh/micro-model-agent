import type { AgentModule, AgentPlugin } from '../types'
import type { PromptBlock } from '../../core/types'
import type { SkillMeta } from './loader'
import type { SkillsMatcher } from './matcher'

export interface LoadResult {
  success: boolean
  message: string
  skill?: SkillMeta
}

export class SkillsModule implements AgentModule {
  name = 'skills'

  private availableSkills: SkillMeta[]
  private loadedSkills: Map<string, SkillMeta> = new Map()
  private matcher: SkillsMatcher
  private budget: number
  private currentTokens = 0

  constructor(availableSkills: SkillMeta[], matcher: SkillsMatcher, budget: number) {
    this.availableSkills = availableSkills
    this.matcher = matcher
    this.budget = budget
  }

  loadByName(name: string): LoadResult {
    if (this.loadedSkills.has(name)) {
      return { success: false, message: `Skill "${name}" is already loaded` }
    }

    const skill = this.availableSkills.find(s => s.name === name)
    if (!skill) {
      return { success: false, message: `Skill "${name}" not found in any source directory` }
    }

    return this.tryLoad(skill)
  }

  loadByMatch(taskDescription: string): LoadResult {
    const matches = this.matcher.match(taskDescription, this.availableSkills, 1)
    if (matches.length === 0) {
      return { success: false, message: `No skills match for: ${taskDescription}` }
    }
    return this.tryLoad(matches[0])
  }

  unload(name: string): boolean {
    const skill = this.loadedSkills.get(name)
    if (!skill) return false
    this.loadedSkills.delete(name)
    this.currentTokens -= this.estimateTokens(skill.content)
    return true
  }

  getLoaded(): SkillMeta[] {
    return Array.from(this.loadedSkills.values())
  }

  getAvailable(): SkillMeta[] {
    return this.availableSkills
  }

  findByName(name: string): SkillMeta | undefined {
    return this.availableSkills.find(s => s.name === name)
  }

  search(query: string): SkillMeta[] {
    return this.matcher.match(query, this.availableSkills, 10)
  }

  getBudget(): { used: number; total: number; remaining: number } {
    return {
      used: this.currentTokens,
      total: this.budget,
      remaining: this.budget - this.currentTokens,
    }
  }

  getSkillContent(name: string): string | null {
    const skill = this.loadedSkills.get(name)
    return skill ? skill.content : null
  }

  getSystemPromptBlock(): PromptBlock | null {
    if (this.loadedSkills.size === 0) return null

    const lines = ['[Loaded Skills]']
    for (const skill of this.loadedSkills.values()) {
      const desc = skill.description.slice(0, 80)
      lines.push(`- ${skill.name}: ${desc}`)
    }

    const content = lines.join('\n')
    const tokens = this.estimateTokens(content)

    return {
      content,
      priority: 'normal',
      essential: false,
      estimatedTokens: tokens,
    }
  }

  getPlugin(): AgentPlugin {
    return {
      name: 'skills',
      onSessionStart: (_ctx: any) => {},
    }
  }

  private tryLoad(skill: SkillMeta): LoadResult {
    const tokens = this.estimateTokens(skill.content)

    if (tokens > this.budget) {
      return {
        success: false,
        message: `Skill "${skill.name}" is too large (${tokens} tokens). Budget: ${this.budget} tokens`,
      }
    }

    if (this.currentTokens + tokens > this.budget) {
      const remaining = this.budget - this.currentTokens
      return {
        success: false,
        message: `Skill "${skill.name}" (${tokens} tokens) exceeds remaining budget (${remaining} tokens). Unload other skills first.`,
      }
    }

    this.loadedSkills.set(skill.name, skill)
    this.currentTokens += tokens

    return {
      success: true,
      message: `Skill "${skill.name}" loaded (${tokens} tokens, ${this.budget - this.currentTokens} remaining)`,
      skill,
    }
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }
}
