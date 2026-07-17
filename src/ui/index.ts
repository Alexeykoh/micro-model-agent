import type { OutputRenderer, StatusInfo } from './renderer.js'

export type { OutputRenderer, StatusInfo } from './renderer.js'

export async function createRenderer(): Promise<OutputRenderer> {
  const { ReadlineRenderer } = await import('./readline-renderer.js')
  const r = new ReadlineRenderer()
  await r.start()
  return r
}
