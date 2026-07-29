export interface SessionMeta {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  messageCount: number
  model: string
  contextWindow: number
  projectDir: string
}

export interface SessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  timestamp: string
}


