/** Загрузка модели LM Studio с нужной длиной контекста. */
import type { Logger } from "../logger/app-logger";

/** Конфиг загрузки: модель, контекст, флаги GPU/батча. */
export interface ModelLoadConfig {
  model: string;
  contextLength: number;
  flashAttention?: boolean;
  evalBatchSize?: number;
  offloadKvCacheToGpu?: boolean;
  autoLoad?: boolean;
}

/** Итог загрузки: успех, уже загружена, время, ошибка. */
export interface LoadResult {
  success: boolean;
  alreadyLoaded?: boolean;
  loadTime?: number;
  error?: string;
}

// Хелперы живой context-probe — в ./provider-context.ts и ./models-dev.ts;
// реэкспорт отсюда, чтобы существующие импорты не ломать.
export {
  probeModel,
  getLoadedContextLength,
  probeProviderContext,
  type ContextProbeResult,
  type ModelProbeResult,
  type ProviderContextOpts,
} from "./provider-context";

interface LmStudioLoadResponse {
  load_time_seconds?: number;
  loadTime?: number;
}

/** Нативная форма `/api/v1/models`, которую читает сам загрузчик (проверка load). */
interface LmStudioStatusResponse {
  models?: Array<{
    key?: string;
    name?: string;
    loaded_instances?: Array<{ config?: { context_length?: number } }>;
  }>;
}

/** Загрузчик модели LM Studio: ensure + load через native API. */
export class ModelLoader {
  private baseUrl: string;
  private logger: Logger;

  constructor(baseUrl: string, logger: Logger) {
    const url = baseUrl.replace(/\/$/, "");
    this.baseUrl = url.replace(/\/v1\/?$/, "");
    this.logger = logger;
  }

  /**
   * Гарантирует загруженную модель с нужным контекстом (иначе грузит).
   * @param config конфиг загрузки; @returns итог (уже была/загружена/ошибка).
   */
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

      const data = (await response.json()) as LmStudioStatusResponse;
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
