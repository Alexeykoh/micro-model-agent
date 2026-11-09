// Эндпоинт АКТИВНОГО провайдера (INV-23): выделен из `manager.ts`, чтобы
// `reasoning-resolve.ts` не импортировал менеджер (fallow circular).
import type { ProviderConfig } from "../../config/types";

/**
 * Эндпоинт АКТИВНОГО провайдера для внеполосных вызовов (context probe,
 * автозагрузка моделей, ключ кеша reasoning-пробы). Легаси-плоские поля
 * (`type`/`baseUrl`/`apiKey`) отражают активное на момент последней записи и
 * протухают после hot-swap `/provider use` — истина в entries. Фолбэк на
 * плоские поля для легаси-конфигов.
 */
export function activeProviderEndpoint(
  config?: Pick<ProviderConfig, "entries" | "active" | "type" | "baseUrl" | "apiKey">,
): { baseUrl: string; apiKey?: string; type: string } {
  const entries = Array.isArray(config?.entries) ? config.entries : [];
  const active =
    entries.find((e) => e.label === config?.active || e.type === config?.active) ?? entries[0];
  if (active) {
    return { baseUrl: active.baseUrl, apiKey: active.apiKey, type: active.type };
  }
  return { baseUrl: config?.baseUrl ?? "", apiKey: config?.apiKey, type: config?.type ?? "openai-compat" };
}
