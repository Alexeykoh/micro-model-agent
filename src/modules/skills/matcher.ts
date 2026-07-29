import type { SkillMeta } from './loader'

const MIN_WORD_LENGTH = 4

export class SkillsMatcher {
  match(taskDescription: string, skills: SkillMeta[], maxResults = 3): SkillMeta[] {
    const taskWords = taskDescription.toLowerCase().split(/\W+/).filter(w => w.length >= MIN_WORD_LENGTH)

    const scored = skills.map(skill => {
      const allKeywords = [
        skill.name.toLowerCase(),
        skill.description.toLowerCase(),
        ...skill.keywords.map(k => k.toLowerCase()),
      ]

      let score = 0
      for (const word of taskWords) {
        for (const kw of allKeywords) {
          if (kw === word || (kw.length >= MIN_WORD_LENGTH && kw.includes(word))) {
            score++
          }
        }
      }

      return { skill, score }
    })

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(s => s.skill)
  }
}
