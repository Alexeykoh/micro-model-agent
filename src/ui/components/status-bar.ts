import type { StatusInfo } from '../renderer.js'

/**
 * Форматирование строки статуса.
 *
 * Формат: <model> │ step N/M
 *
 * @module ui/components/status-bar
 */

/** Форматирует строку статуса для отображения в терминале */
export function formatStatusLine(info: StatusInfo): string {
  const parts: string[] = []
  if (info.model) {
    const short = info.model.split('/').pop() || info.model
    parts.push(short)
  }
  if (info.step !== undefined && info.maxSteps !== undefined) {
    parts.push(`step ${info.step}/${info.maxSteps}`)
  }
  return parts.join(' │ ') || 'MMA'
}
