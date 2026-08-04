const ERROR_SKILL_MAP: Array<{ pattern: RegExp; skill: string }> = [
  { pattern: /TS\d{4}:/i, skill: 'typescript-expert' },
  { pattern: /Cannot find name|No overload matches/i, skill: 'typescript-type-expert' },
  { pattern: /ts-node|tsx.*error/i, skill: 'typescript-expert' },
  { pattern: /Module not found|Cannot resolve module/i, skill: 'typescript-expert' },
  { pattern: /ECONNREFUSED|ETIMEDOUT|fetch failed/i, skill: 'devops-expert' },
  { pattern: /permission denied|EACCES/i, skill: 'linux-server-expert' },
  { pattern: /docker|container/i, skill: 'docker-expert' },
  { pattern: /jest|vitest|test.*fail/i, skill: 'vitest-testing-expert' },
]

export function suggestSkill(errorOutput: string): string | null {
  for (const { pattern, skill } of ERROR_SKILL_MAP) {
    if (pattern.test(errorOutput)) return skill
  }
  return null
}
