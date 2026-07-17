import type { StatusInfo } from '../renderer.js'

export function formatStatusLine(info: StatusInfo): string {
  const parts: string[] = []
  if (info.provider && info.model) {
    parts.push(`${info.provider}/${info.model}`)
  }
  if (info.tokens !== undefined && info.contextWindow !== undefined) {
    parts.push(`${info.tokens}/${info.contextWindow}`)
  }
  if (info.step !== undefined && info.maxSteps !== undefined) {
    parts.push(`step ${info.step}/${info.maxSteps}`)
  }
  return parts.join(' │ ') || 'MMA — ready'
}
