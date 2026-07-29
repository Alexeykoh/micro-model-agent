export type BrowserAction =
  | 'open'
  | 'click'
  | 'type'
  | 'scroll'
  | 'back'
  | 'forward'
  | 'screenshot'
  | 'snapshot'
  | 'close'
  | 'wait'

export interface ElementEntry {
  index: number
  tag: string
  role: string
  name: string
  value?: string
  href?: string
  visible: boolean
}

export interface PageSnapshot {
  url: string
  title: string
  elements: ElementEntry[]
  truncated: boolean
}

export interface BrowserState {
  isOpen: boolean
  url: string | null
  title: string | null
  elementCount: number
}

export interface BrowserConfig {
  headless: boolean
  maxElements: number
  screenshotMaxWidth: number
  cookieDir: string
  viewportWidth: number
  viewportHeight: number
  navigationTimeout: number
}

export interface ActionResult {
  success: boolean
  output: string
  screenshot?: Buffer
}

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  headless: true,
  maxElements: 30,
  screenshotMaxWidth: 1280,
  cookieDir: '',
  viewportWidth: 1280,
  viewportHeight: 720,
  navigationTimeout: 15000,
}
