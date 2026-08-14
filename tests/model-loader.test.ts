import { describe, it, expect, vi } from 'vitest'
import { ModelLoader } from '../src/llm/model-loader'

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

describe('ModelLoader', () => {
  it('should skip loading when autoLoad is false', async () => {
    const loader = new ModelLoader('http://localhost:1234', mockLogger as any)
    const result = await loader.ensureModelLoaded({
      model: 'test-model',
      contextLength: 32768,
      autoLoad: false,
    })

    expect(result.success).toBe(true)
    expect(result.alreadyLoaded).toBe(true)
  })

  it('should detect already loaded model with correct context', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        models: [{
          key: 'qwen/qwen3.5-9b',
          loaded_instances: [{
            config: { context_length: 32768 }
          }]
        }]
      }),
    })
    global.fetch = mockFetch as any

    const loader = new ModelLoader('http://localhost:1234', mockLogger as any)
    const result = await loader.ensureModelLoaded({
      model: 'qwen/qwen3.5-9b',
      contextLength: 32768,
      autoLoad: true,
    })

    expect(result.success).toBe(true)
    expect(result.alreadyLoaded).toBe(true)
  })

  it('should load model when not loaded', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          type: 'llm',
          instance_id: 'qwen/qwen3.5-9b',
          load_time_seconds: 5.2,
          status: 'loaded',
        }),
      })
    global.fetch = mockFetch as any

    const loader = new ModelLoader('http://localhost:1234', mockLogger as any)
    const result = await loader.ensureModelLoaded({
      model: 'qwen/qwen3.5-9b',
      contextLength: 32768,
      flashAttention: true,
      autoLoad: true,
    })

    expect(result.success).toBe(true)
    expect(result.alreadyLoaded).toBe(false)
    expect(result.loadTime).toBe(5.2)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('should load model when context length differs', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          models: [{
            key: 'qwen/qwen3.5-9b',
            loaded_instances: [{
              config: { context_length: 8192 }
            }]
          }]
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          type: 'llm',
          instance_id: 'qwen/qwen3.5-9b',
          load_time_seconds: 3.1,
          status: 'loaded',
        }),
      })
    global.fetch = mockFetch as any

    const loader = new ModelLoader('http://localhost:1234', mockLogger as any)
    const result = await loader.ensureModelLoaded({
      model: 'qwen/qwen3.5-9b',
      contextLength: 32768,
      autoLoad: true,
    })

    expect(result.success).toBe(true)
    expect(result.alreadyLoaded).toBe(false)
  })

  it('should handle network errors gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'))
    global.fetch = mockFetch as any

    const loader = new ModelLoader('http://localhost:1234', mockLogger as any)
    const result = await loader.ensureModelLoaded({
      model: 'qwen/qwen3.5-9b',
      contextLength: 32768,
      autoLoad: true,
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Connection refused')
  })

  it('should handle load API errors', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Model not found'),
      })
    global.fetch = mockFetch as any

    const loader = new ModelLoader('http://localhost:1234', mockLogger as any)
    const result = await loader.ensureModelLoaded({
      model: 'nonexistent-model',
      contextLength: 32768,
      autoLoad: true,
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('400')
  })

  it('should strip /v1 from baseUrl', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          type: 'llm',
          load_time_seconds: 2.0,
          status: 'loaded',
        }),
      })
    global.fetch = mockFetch as any

    const loader = new ModelLoader('http://localhost:1234/v1', mockLogger as any)
    await loader.ensureModelLoaded({
      model: 'qwen/qwen3.5-9b',
      contextLength: 32768,
      autoLoad: true,
    })

    const loadCall = mockFetch.mock.calls[1]
    expect(loadCall[0]).toBe('http://localhost:1234/api/v1/models/load')
  })

  it('should send correct load parameters', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          type: 'llm',
          load_time_seconds: 2.0,
          status: 'loaded',
        }),
      })
    global.fetch = mockFetch as any

    const loader = new ModelLoader('http://localhost:1234', mockLogger as any)
    await loader.ensureModelLoaded({
      model: 'qwen/qwen3.5-9b',
      contextLength: 65536,
      flashAttention: true,
      evalBatchSize: 512,
      offloadKvCacheToGpu: false,
      autoLoad: true,
    })

    const loadCall = mockFetch.mock.calls[1]
    const body = JSON.parse(loadCall[1]?.body as string)

    expect(body.model).toBe('qwen/qwen3.5-9b')
    expect(body.context_length).toBe(65536)
    expect(body.flash_attention).toBe(true)
    expect(body.eval_batch_size).toBe(512)
    expect(body.offload_kv_cache_to_gpu).toBe(false)
  })
})
