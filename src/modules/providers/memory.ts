/**
 * Память моделей провайдера (домен провайдеров, INV-19): слой конфига её не
 * знает, он лишь вызывает зарегистрированный апплер (`config/registry.ts`).
 *
 * Логика: запись `model` запоминается под активным провайдером; смена
 * `provider.active` восстанавливает запомненную модель провайдера, чтобы свитч
 * молча не оставлял модель, которую новый бэкенд не обслуживает. Заодно
 * зеркалятся легаси-плоские поля (`type`/`baseUrl`/`apiKey`) из активной записи.
 */
import type { AppConfig } from "../../config/types";

/** Зеркалит легаси-плоские поля из активной записи (после hot-swap они протухают). */
function mirrorActiveEntryFields(provider: AppConfig["provider"], activeName: string): void {
  const entry = (provider.entries ?? []).find(
    (e) => e.label === activeName || e.type === activeName,
  );
  if (!entry) return;
  provider.type = entry.type;
  provider.baseUrl = entry.baseUrl;
  provider.apiKey = entry.apiKey;
}

/**
 * Держит `provider.models` (последняя модель каждого провайдера) в синхроне при
 * прямой правке ключа через `/config` (в обход `Agent.setProvider`). Ключи вне
 * `{model, provider.active}` игнорируются.
 */
export function syncProviderModelMemory(config: AppConfig, key: string, value: unknown): void {
  const provider = config.provider;
  const activeName = provider.active ?? provider.type;
  if (key === "model") {
    if (!activeName) return;
    provider.models = { ...(provider.models ?? {}), [activeName]: String(value) };
    return;
  }
  if (key === "provider.active") {
    const remembered = provider.models?.[String(value)];
    if (remembered) config.model = remembered;
    mirrorActiveEntryFields(provider, String(value));
  }
}
