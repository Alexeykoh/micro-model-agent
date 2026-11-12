/**
 * Context-probe активной записи провайдера (INV-W6/INV-15).
 *
 * Вынесено из `provider-phase.ts` (правило ≤300 строк). Provider-first проба
 * окна, кеш по идентичности и диагностика — reconfigure применяет результат.
 */
import type { AppConfig } from "../../config/types";
import type { Logger } from "../../logger/app-logger";
import type { ContextProbeResult } from "../../llm/provider-context";
import { activeProviderEndpoint } from "../../modules/providers/manager";
import { errMsg } from "../../utils/error";
import { probeIdentityOf, publishContextProbe, type ProbeIdentity } from "./provider-probes";
import type { ProviderPhaseHost } from "./provider-phase";

/** Ключ кеша измеренного окна: `baseUrl + model + type` (INV-W6). */
export function probeCacheKey(id: ProbeIdentity): string {
  return `${id.baseUrl}|${id.model}|${id.type ?? ""}`;
}

/** Логгер хоста (у `AgentDeps.logger` есть `.warn`/`.info`). */
function loggerOf(host: ProviderPhaseHost): Logger {
  return host.deps.logger;
}

/**
 * Смена окна по пробе — диагностика харнесса, а не сообщение пользователю:
 * строка «Context probe: auto-set contextWindow…» попадала в ленту обычного
 * режима (quiet). Через `diagnostic` она видна только в `verbose`.
 */
export function logContextProbeAutoSet(
  logger: Pick<Logger, "diagnostic"> | undefined,
  model: string,
  actual: number,
  configured: number,
): void {
  if (typeof logger?.diagnostic !== "function") return;
  logger.diagnostic(
    "info",
    `Context probe: auto-set contextWindow from provider — model "${model}" serves ${actual} tokens (configured was ${configured}).`,
  );
}

/**
 * Provider-first проба контекста активной записи при смене идентичности.
 * Fail-open; при `contextAuto: false` проба пропускается целиком.
 *
 * Измеренное окно кешируется по идентичности (`baseUrl + model + type`, INV-W6):
 * возврат на уже измеренную идентичность сети не касается. Кешируются только
 * успешные измерения — молчащий бэкенд остаётся пробируемым.
 */
export async function reprobeActiveProvider(
  host: ProviderPhaseHost,
  config: AppConfig,
): Promise<void> {
  try {
    const nextId = probeIdentityOf(config);
    const prevId = host.lastProbeIdentity;
    const identityChanged =
      prevId.model !== nextId.model ||
      prevId.baseUrl !== nextId.baseUrl ||
      prevId.active !== nextId.active ||
      prevId.type !== nextId.type;
    if (!identityChanged) return;
    if (config.contextAuto === false) {
      host.lastProbeIdentity = nextId;
      publishContextProbe(host.deps.contextProbeRef, null);
      return;
    }
    const cacheKey = probeCacheKey(nextId);
    let detected: ContextProbeResult | null | undefined = host.probeWindowCache.get(cacheKey);
    if (!detected) {
      const nextEndpoint = activeProviderEndpoint(config.provider);
      const { probeProviderContext } = await import("../../llm/model-loader");
      // Один сетевой запрос: `probeProviderContext` сам спрашивает LM Studio
      // native первым источником — отдельный `probeModel` здесь дублировал его.
      detected = (await probeProviderContext(nextEndpoint.baseUrl, config.model, {
        apiKey: nextEndpoint.apiKey,
        providerType: nextEndpoint.type,
      })) ?? null;
      if (detected) host.probeWindowCache.set(cacheKey, detected);
    }
    publishContextProbe(host.deps.contextProbeRef, detected);
    if (detected && detected.actual !== config.contextWindow) {
      // Сначала применяем окно, потом пишем диагностику: сбой логгера не должен
      // отменять уже принятую пробу (в тестах и сторонних логгерах нет
      // `diagnostic`, и исключение раньше съедало присваивание).
      const configured = config.contextWindow;
      config.contextWindow = detected.actual;
      // Окно из кеша не логируем: это не новое измерение с провайдера.
      logContextProbeAutoSet(loggerOf(host), detected.model, detected.actual, configured);
    }
    host.lastProbeIdentity = nextId;
  } catch (err) {
    // Проба — best-effort, переключение модели/провайдера не блокируем никогда.
    // INV-15: «не смогли измерить» не должно выглядеть как «окно такое и есть».
    const cause = errMsg(err);
    host.deps.onDiagnostic?.({
      source: "module:providers",
      operation: "provider.context_probe",
      kind: "degraded",
      cause,
      recoverable: true,
      detail: { model: config.model },
    });
    publishContextProbe(host.deps.contextProbeRef, null);
    loggerOf(host).diagnostic(
      "warn",
      `Context probe failed for "${config.model}" — keeping configured contextWindow: ${cause}`,
    );
  }
}
