/**
 * Стартовая проба возможностей с учётом холодных локальных бэкендов.
 * Вынесено из `provider-phase.ts` (правило 6: файл ≤300 строк).
 */
import {
  discoverCapabilities,
  type DiscoveredCapabilities,
} from "../agent/provider-probes";
import {
  readCachedCapabilities,
  writeCachedCapabilities,
} from "../../modules/providers/capabilities-cache";

/** Эндпоинт активной записи (тот же вид, что `activeProviderEndpoint`). */
export interface CapabilitiesEndpoint {
  baseUrl: string;
  apiKey?: string;
  type: string;
}

/**
 * llama-swap на холодную модель отвечает 409 на `/props?model=…&autoload=false`,
 * поэтому после неудачной native-пробы берём последний настоящий verdict для
 * той же пары из кэша (TTL 24 ч). Кэш обновляется только успешной пробой.
 */
export async function probeStartupCapabilities(
  endpoint: CapabilitiesEndpoint,
  model: string,
  opts: { probeOffSwitch?: boolean } = {},
): Promise<DiscoveredCapabilities> {
  const native = await discoverCapabilities(endpoint, model, opts);
  if (native.capabilities) {
    writeCachedCapabilities(endpoint.baseUrl, model, native.capabilities);
    return native;
  }
  return {
    ...native,
    capabilities: native.reachable === true ? readCachedCapabilities(endpoint.baseUrl, model) : undefined,
  };
}
