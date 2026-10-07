// Резолв ссылки на провайдера: `critic.provider` / `orchestrator.provider`
// могут быть как полным объектом ProviderConfig, так и именем записи
// `provider.entries[]` (лейбл или тип). Имя резолвится в запись, чтобы UI мог
// показывать провайдера выпадающим списком, не дублируя baseUrl/apiKey.
import type { AppConfig, ProviderConfig, ProviderEntry } from "../../config/types";

/** Имя записи провайдера: пользовательский лейбл важнее типа. */
export function providerEntryName(entry: ProviderEntry): string {
  return entry.label || entry.type;
}

/**
 * Резолвит `ProviderConfig | string | undefined` в конфиг провайдера.
 * - объект → как есть;
 * - имя, найденное в `provider.entries` → запись (плоский конфиг);
 * - пусто/неизвестное имя → `undefined` (вызывающий падает на активный провайдер).
 */
export function resolveProviderRef(
  config: AppConfig,
  ref: ProviderConfig | string | undefined,
): ProviderConfig | undefined {
  if (!ref) return undefined;
  if (typeof ref !== "string") return ref;
  const name = ref.trim();
  if (!name) return undefined;
  const entries = config.provider?.entries ?? [];
  const entry = entries.find((e) => providerEntryName(e) === name || e.type === name);
  if (!entry) return undefined;
  return { ...entry, type: entry.type, baseUrl: entry.baseUrl };
}
