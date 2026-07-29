import type { AgentModule, AgentPlugin } from '../types'
import type { PromptBlock } from '../../core/types'
import type { SkillMeta } from './loader'
import type { SkillsMatcher } from './matcher'
import pc from 'picocolors'

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
    const lines: string[] = []

    if (this.availableSkills.length > 0) {
      lines.push('[Available Skills]')
      lines.push('Use load_skill tool with task parameter to load relevant skill before answering domain-specific questions.')
      for (const skill of this.availableSkills) {
        const desc = skill.description.slice(0, 80)
        lines.push(`- ${skill.name}: ${desc}`)
      }
    }

    if (this.loadedSkills.size > 0) {
      lines.push('[Loaded Skills]')
      for (const skill of this.loadedSkills.values()) {
        const desc = skill.description.slice(0, 80)
        lines.push(`- ${skill.name}: ${desc}`)
      }
    }

    if (lines.length === 0) return null

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
    let autoLoadedThisRun = false
    return {
      name: 'skills',
      onSessionStart: (_ctx: any) => {
        autoLoadedThisRun = false
      },
      onBeforeThink: (ctx: any) => {
        if (autoLoadedThisRun) return
        const msg = ctx?.lastUserMessage as string | undefined
        if (!msg || this.availableSkills.length === 0) return

        const matches = this.matcher.match(msg, this.availableSkills, 1)
        if (matches.length === 0) return

        const skill = matches[0]
        if (this.loadedSkills.has(skill.name)) return

        const tokens = this.estimateTokens(skill.content)
        if (this.currentTokens + tokens > this.budget) return

        this.loadedSkills.set(skill.name, skill)
        this.currentTokens += tokens

        const contextManager = ctx?.contextManager
        if (contextManager) {
          const content = `[Skill loaded: ${skill.name}]\n${skill.content}\n\nUse this knowledge to answer the user's question.`
          contextManager.addMessage({ role: 'user', content: `<system-instruction>${content}</system-instruction>` })
        }

        const onMeta = ctx?.onMeta as ((meta: string) => void) | undefined
        if (onMeta) {
          onMeta(pc.dim(`[Auto-loaded skill: ${skill.name}]`) + '\n')
        }
        autoLoadedThisRun = true
      },
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
