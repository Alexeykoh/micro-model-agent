

/** Плоские поля v1, которые раскладываются в запись провайдера. */
const V1_PROVIDER_FIELDS = ["apiBase", "baseUrl", "apiKey", "chatEndpoint", "providerType"] as const;

/** Ключи v2, которые переносятся как есть. */
const V2_PASSTHROUGH = ["contextWindow", "contextBudget", "model", "locale", "instructions"] as const;

/**
 * Конвертирует сырой v1-конфиг в форму v2.
 *
 * Неизвестные ключи сохраняются: конфиг пользователя — не наш черновик.
 */
export function convertV1toV2(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };

  const baseUrl = firstString(raw.apiBase, raw.baseUrl, raw.chatEndpoint);
  const apiKey = firstString(raw.apiKey);
  const type = firstString(raw.providerType) ?? "openai-compat";

  if (baseUrl) {
    const entry: Record<string, unknown> = { type, baseUrl };
    if (apiKey) entry.apiKey = apiKey;
    if (typeof raw.maxTokens === "number") entry.maxCompletionTokens = raw.maxTokens;
    if (typeof raw.temperature === "number") entry.temperature = raw.temperature;

    const provider: Record<string, unknown> = {
      ...(typeof raw.provider === "object" && raw.provider ? raw.provider : {}),
      type,
      baseUrl,
      entries: [entry],
      active: type,
    };
    if (apiKey) provider.apiKey = apiKey;
    out.provider = provider;
  }

  for (const key of V1_PROVIDER_FIELDS) delete out[key];
  for (const key of V2_PASSTHROUGH) {
    if (out[key] === undefined) delete out[key];
  }
  // `version` — маркер формата: после конвертации он должен быть v2.
  out.version = "2.0.0";
  out.__schema = 2;

  return out;
}

/** Первый непустой строковый аргумент. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
