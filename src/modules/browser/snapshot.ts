import type { ElementEntry, PageSnapshot } from './types'
import { t } from '../../i18n/index'

function inferRole(tag: string, type?: string): string {
  const t = tag.toLowerCase()
  if (t === 'a') return 'link'
  if (t === 'button') return 'button'
  if (t === 'input') {
    const inputType = type?.toLowerCase()
    if (inputType === 'submit' || inputType === 'button') return 'button'
    if (inputType === 'checkbox') return 'checkbox'
    if (inputType === 'radio') return 'radio'
    return 'textbox'
  }
  if (t === 'textarea') return 'textbox'
  if (t === 'select') return 'combobox'
  return 'widget'
}

function getName(tag: string, attrs: Record<string, string>, html: string, matchIndex: number): string {
  const fromAttr = (
    attrs['aria-label'] ||
    attrs['placeholder'] ||
    attrs['title'] ||
    attrs['alt'] ||
    attrs['value'] ||
    attrs['name'] ||
    ''
  )
  if (fromAttr) return fromAttr

  const afterTag = html.slice(matchIndex)
  const closeIdx = afterTag.indexOf('>')
  if (closeIdx === -1) return ''
  const afterOpen = afterTag.slice(closeIdx + 1)
  const endTag = `</${tag}>`
  const endIdx = afterOpen.indexOf(endTag)
  if (endIdx === -1) return ''
  const text = afterOpen.slice(0, endIdx).replace(/<[^>]+>/g, '').trim()
  return text.slice(0, 50)
}

export function extractInteractiveElements(html: string, maxElements = 30): ElementEntry[] {
  const elements: ElementEntry[] = []
  const tagRegex = /<(a|button|input|textarea|select|div|span)([^>]*)>/gi
  let match: RegExpExecArray | null

  while ((match = tagRegex.exec(html)) !== null) {
    if (elements.length >= maxElements) break

    const tag = match[1].toLowerCase()
    const attrStr = match[2]

    const attrs: Record<string, string> = {}
    const attrRegex = /(\w[\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g
    let attrMatch: RegExpExecArray | null
    while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
      attrs[attrMatch[1].toLowerCase()] = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? ''
    }

    if (attrs['style']?.includes('display:none') || attrs['style']?.includes('display: none')) continue
    if (attrs['hidden'] !== undefined) continue
    if (attrs['aria-hidden'] === 'true') continue
    if (tag === 'input' && attrs['type'] === 'hidden') continue

    const role = attrs['role'] || inferRole(tag, attrs['type'])
    const isInteractive = [
      'a', 'button', 'input', 'textarea', 'select',
    ].includes(tag) || attrs['role'] !== undefined

    if (!isInteractive) continue
    if (tag === 'a' && !attrs['href']) continue

    const name = getName(tag, attrs, html, match.index)

    elements.push({
      index: elements.length + 1,
      tag,
      role,
      name,
      value: attrs['value'],
      href: attrs['href'],
      visible: true,
    })
  }

  return elements
}

export function formatSnapshot(snapshot: PageSnapshot): string {
  const lines: string[] = []
  lines.push(`Page: "${snapshot.title}"`)
  lines.push(`URL: ${snapshot.url}`)
  lines.push('')

  if (snapshot.elements.length === 0 && !snapshot.truncated) {
    lines.push(t('browser.no_elements'))
    return lines.join('\n')
  }

  for (const el of snapshot.elements) {
    let line = `[${el.index}] ${el.role}`
    if (el.name) line += ` "${el.name}"`
    if (el.href) line += ` → ${el.href}`
    if (el.value) line += ` = "${el.value}"`
    lines.push(line)
  }

  if (snapshot.truncated) {
    lines.push('')
    lines.push(t('browser.more_elements'))
  }

  return lines.join('\n')
}
