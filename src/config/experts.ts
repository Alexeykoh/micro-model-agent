import type { AppConfig, ExpertConfig } from './types'

export function getExpertConfig(config: AppConfig, tag: string): ExpertConfig | undefined {
  return config.experts?.[tag]
}

export function validateExpertConfig(config: AppConfig, allToolTags: string[]): string[] {
  const errors: string[] = []
  const knownTags = new Set(allToolTags)

  for (const [name, expert] of Object.entries(config.experts || {})) {
    for (const tag of expert.tool_tags) {
      if (!knownTags.has(tag)) {
        errors.push(`Expert "${name}" references unknown tool_tag "${tag}". Known tags: ${Array.from(knownTags).join(', ')}`)
      }
    }
  }

  return errors
}
