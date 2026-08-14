import { describe, it, expect, vi } from 'vitest'
import { OpenAICompatProvider } from '../src/llm/openai-compat'

describe('OpenAICompatProvider', () => {
  it('should construct with config', () => {
    const provider = new OpenAICompatProvider({
      model: 'qwen/qwen3.5-9b',
      baseUrl: 'http://localhost:1234/v1',
    })
    expect(provider.model).toBe('qwen/qwen3.5-9b')
    expect(provider.contextWindow).toBe(32768)
  })

  it('should respect contextWindow option', () => {
    const provider = new OpenAICompatProvider({
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
      contextWindow: 64000,
    })
    expect(provider.contextWindow).toBe(64000)
  })

  it('should stream text chunks', async () => {
    const provider = new OpenAICompatProvider({
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
    })

    const mockFetch = vi.fn()
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    mockFetch.mockResolvedValue({
      ok: true,
      body: stream,
      headers: new Map(),
    })
    global.fetch = mockFetch as any

    const chunks: string[] = []
    for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
      if (chunk.type === 'text' && chunk.content) chunks.push(chunk.content)
    }
    expect(chunks.join('')).toBe('Hello world')
  })

  it('should parse tool_calls from stream', async () => {
    const provider = new OpenAICompatProvider({
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
    })

    const mockFetch = vi.fn()
    const encoder = new TextEncoder()
    const toolCallDelta = {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_1',
            function: { name: 'read_file', arguments: '{"path":"test.txt"}' }
          }]
        }
      }]
    }
    const doneLine = {
      choices: [{
        delta: {},
        finish_reason: 'tool_calls'
      }]
    }
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(toolCallDelta)}\n\n`))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneLine)}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    mockFetch.mockResolvedValue({
      ok: true,
      body: stream,
      headers: new Map(),
    })
    global.fetch = mockFetch as any

    let toolCall: any = null
    for await (const chunk of provider.chat([{ role: 'user', content: 'read file' }])) {
      if (chunk.type === 'tool_call') toolCall = chunk.toolCall
    }
    expect(toolCall).not.toBeNull()
    expect(toolCall!.name).toBe('read_file')
  })

  it('should wrap tools in OpenAI function format', async () => {
    const provider = new OpenAICompatProvider({
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
    })

    let requestBody: any = null
    const mockFetch = vi.fn()
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      requestBody = JSON.parse(init.body as string)
      return Promise.resolve({
        ok: true,
        body: stream,
        headers: new Map(),
      })
    })
    global.fetch = mockFetch as any

    const tools = [
      { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
      { name: 'write_file', description: 'Write a file', parameters: { type: 'object', properties: {} } },
    ]

    for await (const _ of provider.chat([{ role: 'user', content: 'hi' }], tools)) { }

    expect(requestBody).not.toBeNull()
    expect(requestBody.tools).toHaveLength(2)
    expect(requestBody.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} },
      },
    })
    expect(requestBody.tools[1].type).toBe('function')
    expect(requestBody.tools[1].function.name).toBe('write_file')
  })

  it('should not include tools in body when tools is empty', async () => {
    const provider = new OpenAICompatProvider({
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
    })

    let requestBody: any = null
    const mockFetch = vi.fn()
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      requestBody = JSON.parse(init.body as string)
      return Promise.resolve({
        ok: true,
        body: stream,
        headers: new Map(),
      })
    })
    global.fetch = mockFetch as any

    for await (const _ of provider.chat([{ role: 'user', content: 'hi' }])) { }

    expect(requestBody.tools).toBeUndefined()
  })

  it('should handle API errors', async () => {
    const provider = new OpenAICompatProvider({
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve('{"error":"auth failed"}'),
    })
    global.fetch = mockFetch as any

    try {
      for await (const _ of provider.chat([{ role: 'user', content: 'hi' }])) { }
      expect.unreachable('Should have thrown')
    } catch (e: any) {
      expect(e.message).toContain('401')
    }
  })

  it('should retry on 5xx errors with exponential backoff', async () => {
    const provider = new OpenAICompatProvider({
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
      retry: { maxRetries: 2, baseDelay: 10, maxDelay: 100 },
    })

     const mockFetch = vi.fn()
      .mockResolvedValueOnce({ 
        ok: false, 
        status: 500, 
        statusText: 'Internal Server Error',
        json: () => Promise.reject(new Error('Internal Server Error')),
        text: () => Promise.resolve('Internal Server Error')
      })
      .mockResolvedValueOnce({ 
        ok: false, 
        status: 503, 
        statusText: 'Service Unavailable',
        json: () => Promise.reject(new Error('Service Unavailable')),
        text: () => Promise.resolve('Service Unavailable')
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: 'test' } }] }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            controller.close()
          },
        }),
      })
    global.fetch = mockFetch as any

     const chunks: any[] = []
     for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
       chunks.push(chunk)
     }

     expect(mockFetch).toHaveBeenCalledTimes(4)
     expect(chunks).toHaveLength(1)
     expect(chunks[0].type).toBe('text')
   })

  it('should retry on 429 rate limit', async () => {
    const provider = new OpenAICompatProvider({
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
      retry: { maxRetries: 1, baseDelay: 10, maxDelay: 100 },
    })

     const mockFetch = vi.fn()
      .mockResolvedValueOnce({ 
        ok: false, 
        status: 429, 
        statusText: 'Too Many Requests',
        json: () => Promise.reject(new Error('Rate limited')),
        text: () => Promise.resolve('Rate limited')
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: 'test' } }] }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            controller.close()
          },
        }),
      })
     global.fetch = mockFetch as any

     for await (const _ of provider.chat([{ role: 'user', content: 'hi' }])) { }

     expect(mockFetch).toHaveBeenCalledTimes(3)
   })

  it('should not retry on 4xx errors except 429', async () => {
    const provider = new OpenAICompatProvider({
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
      retry: { maxRetries: 3, baseDelay: 10, maxDelay: 100 },
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: () => Promise.resolve('{"error":"bad request"}'),
    })
    global.fetch = mockFetch as any

    try {
      for await (const _ of provider.chat([{ role: 'user', content: 'hi' }])) { }
      expect.unreachable('Should have thrown')
    } catch (e: any) {
      expect(e.message).toContain('400')
    }

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('should retry on network errors', async () => {
    const provider = new OpenAICompatProvider({
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
      retry: { maxRetries: 2, baseDelay: 10, maxDelay: 100 },
    })

     const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: 'test' } }] }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            controller.close()
          },
        }),
      })
    global.fetch = mockFetch as any

     const chunks: any[] = []
     for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
       chunks.push(chunk)
     }

     expect(mockFetch).toHaveBeenCalledTimes(4)
     expect(chunks).toHaveLength(1)
   })

  it('should throw after max retries exceeded', async () => {
    const provider = new OpenAICompatProvider({
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
      retry: { maxRetries: 2, baseDelay: 10, maxDelay: 100 },
    })

    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))
    global.fetch = mockFetch as any

    try {
      for await (const _ of provider.chat([{ role: 'user', content: 'hi' }])) { }
      expect.unreachable('Should have thrown')
    } catch (e: any) {
      expect(e.message).toBe('Network error')
    }

    expect(mockFetch).toHaveBeenCalledTimes(3)
  })
})
