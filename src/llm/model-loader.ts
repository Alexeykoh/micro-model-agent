import type { Logger } from "../logger/app-logger";
import type { ModelCapabilities } from "../config/types";

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

/** Result of the native model probe: context window + advertised capabilities. */
export interface ModelProbeResult {
  model: string;
  /** Context length of the loaded instance (tokens). */
  contextLength: number;
  /** Advertised capabilities, when the backend reports them (LM Studio). */
  capabilities?: ModelCapabilities;
}

/** Minimal shape of an LM Studio `/api/v1/models` entry we consume. */
interface LmStudioModel {
  key?: string;
  name?: string;
  max_context_length?: number;
  loaded_instances?: Array<{ config?: { context_length?: number } }>;
  capabilities?: { vision?: boolean; trained_for_tool_use?: boolean };
}
interface LmStudioModelsResponse {
  models?: LmStudioModel[];
}
interface LmStudioLoadResponse {
  load_time_seconds?: number;
  loadTime?: number;
}

/**
 * Ask the backend's native API (LM Studio `/api/v1/models`) for the loaded
 * model's context length AND advertised capabilities. Context length prefers
 * the running instance (`loaded_instances[].config.context_length`), falling
 * back to `max_context_length`. Capabilities are read from `capabilities`
 * (`vision`, `trained_for_tool_use`) when present — this is the single source
 * of truth that replaces name-based vision guessing.
 *
 * Returns null when the endpoint is unavailable (not LM Studio), the model is
 * not found/loaded, or the request fails — the caller must degrade silently.
 */
export async function probeModel(
  baseUrl: string,
  model: string,
  timeoutMs = 3000,
): Promise<ModelProbeResult | null> {
  const base = baseUrl.replace(/\/$/, "").replace(/\/v1\/?$/, "");
  try {
    const response = await fetch(`${base}/api/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as LmStudioModelsResponse;
    const models = data.models ?? [];
    const found = models.find(
      (m) => m.key === model || m.name === model || (m.key ? model.includes(m.key) : false),
    );
    if (!found) return null;
    const loadedInstance = (found.loaded_instances ?? [])[0];
    const contextLength = loadedInstance?.config?.context_length ?? found.max_context_length;
    if (typeof contextLength !== "number" || contextLength <= 0) return null;

    const raw = found.capabilities;
    let capabilities: ModelCapabilities | undefined;
    if (raw && typeof raw.vision === "boolean") {
      capabilities = { vision: raw.vision };
      if (typeof raw.trained_for_tool_use === "boolean") {
        capabilities.tools = raw.trained_for_tool_use;
      }
    }

    return { model: found.key ?? found.name ?? model, contextLength, capabilities };
  } catch {
    return null;
  }
}

/**
 * Thin context-only projection of {@link probeModel}. Kept for callers that
 * only need the context window (banner, context-probe diagnostics).
 */
export async function getLoadedContextLength(
  baseUrl: string,
  model: string,
  timeoutMs = 3000,
): Promise<ContextProbeResult | null> {
  const probe = await probeModel(baseUrl, model, timeoutMs);
  return probe ? { model: probe.model, actual: probe.contextLength } : null;
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

      const data = (await response.json()) as LmStudioModelsResponse;
      const models = data.models ?? [];

      const found = models.find((m) => m.key === model || m.name === model);
      if (!found) return false;

      const loadedInstances = found.loaded_instances ?? [];
      return loadedInstances.some((inst) => inst.config?.context_length === contextLength);
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

    const result = (await response.json()) as LmStudioLoadResponse;
    this.logger.debug(`Model load response: ${JSON.stringify(result)}`);
    const loadTime = result.load_time_seconds ?? result.loadTime;

    return {
      success: true,
      alreadyLoaded: false,
      loadTime,
    };
  }
}
