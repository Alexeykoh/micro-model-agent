import type { SkillMeta } from './loader'

export class SkillsMatcher {
  match(taskDescription: string, skills: SkillMeta[], maxResults = 3): SkillMeta[] {
    const taskWords = taskDescription.toLowerCase().split(/\W+/).filter(Boolean)

    const scored = skills.map(skill => {
      const allKeywords = [
        skill.name.toLowerCase(),
        skill.description.toLowerCase(),
        ...skill.keywords.map(k => k.toLowerCase()),
      ]

      let score = 0
      for (const word of taskWords) {
        for (const kw of allKeywords) {
          if (kw.includes(word) || word.includes(kw)) {
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
