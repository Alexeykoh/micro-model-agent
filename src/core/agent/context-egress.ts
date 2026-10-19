/**
 * DLP-проекция для context-log (E1): снимок контекста должен показывать то же,
 * что реально ушло провайдеру (та же карта токенов, INV-D11). Вынесено из
 * `context-log.ts` — файл на потолке гейта ≤300 (правило 6, ceilings only shrink).
 */
import type { AppConfig } from "../../config/types";
import { activeProviderEndpoint } from "../../modules/providers/manager";
import { getEgressGuard, type ProviderEgressGuard } from "../../modules/providers/sanitizing";

/** Guard активного провайдера для редакции snapshot'а; `undefined` — нет политики. */
export function contextLogGuard(config: AppConfig): ProviderEgressGuard | undefined {
  const endpoint = activeProviderEndpoint(config.provider);
  return getEgressGuard({ type: endpoint.type, baseUrl: endpoint.baseUrl ?? "" });
}
