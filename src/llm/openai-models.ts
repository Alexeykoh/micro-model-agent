/**
 * `GET /models` OpenAI-совместимого провайдера. Вынесено из
 * `OpenAICompatProvider.listModels` (правило 6).
 */
export interface ListModelsOptions {
  baseUrl: string;
  apiKey?: string;
  userAgent: string;
}

/**
 * Таймаут списка моделей (INV-W7): недоступный хост не должен держать
 * HTTP-ответ открыт (раньше fetch висел до TCP-таймаута ОС — минуты).
 */
export const LIST_MODELS_TIMEOUT_MS = 4_000;

/**
 * Список моделей провайдера (`/models`: id/name/model).
 * @returns имена моделей; @throws при недоступности провайдера.
 */
export async function listProviderModels(opts: ListModelsOptions): Promise<string[]> {
  try {
    const url = `${opts.baseUrl.replace(/\/+$/, "")}/models`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": opts.userAgent,
    };
    if (opts.apiKey && opts.apiKey !== "not-needed") {
      headers.Authorization = `Bearer ${opts.apiKey}`;
    }

    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS),
    });

    if (!response.ok) {
      // Провал наружу: health-пробы должны отличать мёртвый провайдер
      // от пустого списка моделей.
      throw new Error(`HTTP ${response.status} from ${url}`);
    }

    const data: unknown = await response.json();
    const rawList: unknown[] = Array.isArray(data)
      ? data
      : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).data)
        ? ((data as Record<string, unknown>).data as unknown[])
        : [];
    const models = rawList
      .map((m) => {
        if (m && typeof m === "object") {
          const obj = m as Record<string, unknown>;
          for (const key of ["id", "name", "model"]) {
            const v = obj[key];
            if (typeof v === "string" && v) return v;
          }
        }
        return "";
      })
      .filter(Boolean);
    return models;
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}
