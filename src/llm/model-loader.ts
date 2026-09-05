import type { Logger } from "../logger/app-logger";

export interface ModelLoadConfig {
  model: string;
  contextLength: number;
  flashAttention?: boolean;
  evalBatchSize?: number;
  offloadKvCacheToGpu?: boolean;
  autoLoad?: boolean;
}

export interface LoadResult {
  success: boolean;
  alreadyLoaded?: boolean;
  loadTime?: number;
  error?: string;
}

/** Result of the startup context probe: what the model is ACTUALLY loaded with. */
export interface ContextProbeResult {
  model: string;
  /** Context length of the loaded instance (tokens). */
  actual: number;
}

/**
 * Ask LM Studio's native API which context length the model is currently
 * loaded with. Prefers the running instance (`loaded_instances[].config.
 * context_length`), falls back to the model's `max_context_length`. Returns
 * null when the endpoint is unavailable (not LM Studio), the model is not
 * found/loaded, or the request fails — the caller must degrade silently.
 */
export async function getLoadedContextLength(
  baseUrl: string,
  model: string,
  timeoutMs = 3000,
): Promise<ContextProbeResult | null> {
  const base = baseUrl.replace(/\/$/, "").replace(/\/v1\/?$/, "");
  try {
    const response = await fetch(`${base}/api/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as any;
    const models: any[] = data.models || [];
    const found = models.find((m) => m.key === model || m.name === model || model.includes(m.key));
    if (!found) return null;
    const loadedInstance = (found.loaded_instances ?? [])[0];
    const actual = loadedInstance?.config?.context_length ?? found.max_context_length;
    if (typeof actual !== "number" || actual <= 0) return null;
    return { model: found.key ?? found.name ?? model, actual };
  } catch {
    return null;
  }
}

export class ModelLoader {
  private baseUrl: string;
  private logger: Logger;

  constructor(baseUrl: string, logger: Logger) {
    const url = baseUrl.replace(/\/$/, "");
    this.baseUrl = url.replace(/\/v1\/?$/, "");
    this.logger = logger;
  }

  async ensureModelLoaded(config: ModelLoadConfig): Promise<LoadResult> {
    if (config.autoLoad === false) {
      return { success: true, alreadyLoaded: true };
    }

    try {
      const isLoaded = await this.isModelLoaded(config.model, config.contextLength);
      if (isLoaded) {
        this.logger.debug(`Model ${config.model} already loaded with correct context`);
        return { success: true, alreadyLoaded: true };
      }

      return await this.loadModel(config);
    } catch (err: any) {
      this.logger.error(`Model loader failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  private async isModelLoaded(model: string, contextLength: number): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/models`, {
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) return false;

      const data = (await response.json()) as any;
      const models = data.models || [];

      const found = models.find((m: any) => m.key === model || m.name === model);
      if (!found) return false;

      const loadedInstances = found.loaded_instances || [];
      return loadedInstances.some((inst: any) => inst.config?.context_length === contextLength);
    } catch {
      return false;
    }
  }

  private async loadModel(config: ModelLoadConfig): Promise<LoadResult> {
    const body: Record<string, unknown> = {
      model: config.model,
      context_length: config.contextLength,
    };

    if (config.flashAttention !== undefined) body.flash_attention = config.flashAttention;
    if (config.evalBatchSize !== undefined) body.eval_batch_size = config.evalBatchSize;
    if (config.offloadKvCacheToGpu !== undefined)
      body.offload_kv_cache_to_gpu = config.offloadKvCacheToGpu;

    this.logger.info(`Loading model ${config.model} with context_length=${config.contextLength}`);
    this.logger.debug(`POST ${this.baseUrl}/api/v1/models/load`);

    const response = await fetch(`${this.baseUrl}/api/v1/models/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Model load failed: HTTP ${response.status}: ${error}`);
      return { success: false, error: `HTTP ${response.status}: ${error}` };
    }

    const result = (await response.json()) as any;
    this.logger.debug(`Model load response: ${JSON.stringify(result)}`);
    const loadTime = result.load_time_seconds ?? result.loadTime;

    return {
      success: true,
      alreadyLoaded: false,
      loadTime,
    };
  }
}
