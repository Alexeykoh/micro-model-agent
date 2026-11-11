/**
 * Пробы провайдера при смене идентичности (INV-R2/R6/R8, INV-15; спека
 * `docs/specs/2026-11-10-provider-switch-probes-design.md`).
 *
 * Смена провайдера/модели (`reconfigure`, `setProvider`, `/provider use`,
 * веб-свитч) обязана перепробить ВСЕ данные бэкенда — контекст, capabilities,
 * reasoning-поддержку — иначе к новому бэкенду применялись данные прошлого
 * (а probe приоритетнее пресета, то есть хуже, чем пресет).
 *
 * Триггер — `probeIdentityOf` (model + baseUrl + active + type). `contextAuto`
 * гейтит только контекстную пробу; capabilities обновляются всегда.
 */
import type { AgentDeps, ContextProbeBox, ProviderProbesBox } from "./deps";
import type { AppConfig, ModelCapabilities, ReasoningStrategy } from "../../config/types";
import type { LLMProvider } from "../../llm/provider";
import type { ContextProbeResult } from "../../llm/provider-context";
import { activeProviderEndpoint } from "../../modules/providers/manager";
import { BUILTIN_PROVIDERS } from "../../modules/providers/presets";
import { t } from "../../i18n/index";
import { errMsg } from "../../utils";

/** Идентичность модели/бэкенда, против которой гонялись пробы. */
export interface ProbeIdentity {
  model: string;
  baseUrl: string;
  active?: string;
  /** Тип записи (`lmstudio`, `openai-compat`, …) — часть идентичности (INV-W6). */
  type?: string;
}

/** Снимок идентичности активной записи (сравнение по значению, не по ссылке). */
export function probeIdentityOf(config: AppConfig): ProbeIdentity {
  const endpoint = activeProviderEndpoint(config.provider);
  return {
    model: config.model,
    baseUrl: endpoint.baseUrl,
    active: config.provider?.active,
    type: endpoint.type,
  };
}

/** Сравнение по значению (write-пути мутят живой конфиг in place). */
export function sameProbeIdentity(a: ProbeIdentity, b: ProbeIdentity): boolean {
  return (
    a.model === b.model &&
    a.baseUrl === b.baseUrl &&
    a.active === b.active &&
    a.type === b.type
  );
}

/** Узкий вид `Agent`, которым владеют пробы смены идентичности. */
export interface SwitchProbeHost {
  deps: Pick<
    AgentDeps,
    "config" | "capabilitiesProbeRef" | "reasoningStrategy" | "reasoningProbe" | "logger" | "onDiagnostic"
  >;
  probePassed: boolean;
}

/** Эндпоинт активной записи для discovery-проб. */
export interface ProbeEndpointRef {
  baseUrl: string;
  apiKey?: string;
  type: string;
}

/** Итог discovery: нативные поля + capabilities с учётом выключателя. */
export interface DiscoveredCapabilities {
  model?: string;
  /** Длина загруженного инстанса (LM Studio native); иначе undefined. */
  contextLength?: number;
  capabilities?: ModelCapabilities;
}

/**
 * Единая discovery-проба возможностей идентичности (спека
 * `2026-11-10-hosted-reasoning-off-discovery-design.md`):
 *
 * 1. native/LM Studio + llama.cpp + декларативные `/models`-capabilities;
 * 2. эмпирический выключатель reasoning: у хостед-шлюзов `reasoningOff` нигде
 *    не декларирован, а строгие серверы на неизвестный `reasoning_effort`
 *    отвечают 400 — значит «can send none» выясняется только одним минимальным
 *    запросом (кэш 24ч/1ч, повторных сетевых вызовов нет).
 *
 * `probeOffSwitch: false` — пропустить эмпирику (например, при
 * `reasoning.mode: "none"`).
 */
export async function discoverCapabilities(
  endpoint: ProbeEndpointRef,
  model: string,
  opts: { timeoutMs?: number; probeOffSwitch?: boolean } = {},
): Promise<DiscoveredCapabilities> {
  const { probeNativeCapabilities } = await import("../../llm/model-loader");
  const native = await probeNativeCapabilities(
    endpoint.baseUrl,
    model,
    opts.timeoutMs ?? 3000,
    endpoint.type,
    endpoint.apiKey,
  );
  const capabilities: ModelCapabilities = { ...(native?.capabilities ?? {}) };
  // Резолв стратегии (caps → пресет) — не «по умолчанию openai-effort»:
  // слать пробное `"none"` prompt-tag-бэкенду бесполезно.
  const presetStrategy = BUILTIN_PROVIDERS.find((p) => p.type === endpoint.type)?.capabilities
    .reasoningStrategy;
  const strategy = capabilities.reasoningStrategy ?? presetStrategy ?? "openai-effort";
  if (
    opts.probeOffSwitch !== false &&
    capabilities.reasoningOff === undefined &&
    strategy === "openai-effort"
  ) {
    const { probeReasoningOffSwitch } = await import("../../llm/reasoning-off-probe");
    const off = await probeReasoningOffSwitch(endpoint.baseUrl, model, {
      apiKey: endpoint.apiKey,
      providerType: endpoint.type,
    });
    // `null` = «не смогли спросить» — не пишем, пресет остаётся (INV-15).
    if (off !== null) capabilities.reasoningOff = off;
  }
  const hasCaps = Object.values(capabilities).some((v) => v !== undefined);
  return {
    model: native?.model,
    contextLength: native?.contextLength,
    capabilities: hasCaps ? capabilities : undefined,
  };
}

/**
 * Перезапрашивает discovery-пробу возможностей активной идентичности и
 * ПЕРЕЗАПИСЫВАЕТ `capabilitiesProbeRef.probe` — включая сброс в `undefined`,
 * если новый бэкенд не заявил capabilities (иначе чужие данные остались бы
 * и перебили пресет нового провайдера). Fail-open: сбой не блокирует свитч,
 * но диагностируется (INV-15).
 */
export async function refreshCapabilitiesProbe(
  host: SwitchProbeHost,
  config: AppConfig,
): Promise<void> {
  const ref = host.deps.capabilitiesProbeRef;
  if (!ref) return;
  try {
    const endpoint = activeProviderEndpoint(config.provider);
    const discovered = await discoverCapabilities(endpoint, config.model, {
      probeOffSwitch: config.reasoning?.mode !== "none",
    });
    ref.probe = discovered.capabilities;
  } catch (err) {
    ref.probe = undefined;
    host.deps.onDiagnostic?.({
      source: "module:providers",
      operation: "provider.capabilities_probe",
      kind: "degraded",
      cause: errMsg(err),
      recoverable: true,
      detail: { model: config.model },
    });
    host.deps.logger.diagnostic(
      "warn",
      `Capabilities probe failed for "${config.model}" — falling back to provider preset: ${errMsg(err)}`,
    );
  }
}

/**
 * Запускает ленивую reasoning-пробу для новой идентичности (фоном, B2):
 * до резолва `probePassed = false` — консервативно, «не подтверждено на этом
 * бэкенде», а не вердикт прошлого. `deps.reasoningProbe` заменяется геттером
 * нового промиса: сессии, стартующие после свитча, ждут его в `session-start`.
 * Устаревший вердикт (идентичность сменилась снова) не применяется.
 */
export function restartReasoningProbe(
  host: SwitchProbeHost,
  config: AppConfig,
  provider: LLMProvider,
): void {
  const { deps } = host;
  host.probePassed = false;
  const strategy: ReasoningStrategy | undefined = deps.reasoningStrategy;
  const needsProbe =
    !!config.reasoning &&
    config.reasoning.mode !== "none" &&
    strategy !== undefined &&
    strategy !== "none";
  if (!needsProbe) {
    publishReasoningProbe(deps, () => Promise.resolve(false));
    return;
  }
  const endpoint = activeProviderEndpoint(config.provider);
  const probe = deps.capabilitiesProbeRef?.probe;
  const idAtStart = probeIdentityOf(config);
  const promise = (async () => {
    try {
      const { probeReasoningSupportCached } = await import("../../modules/reasoning/probe");
      const passed = await probeReasoningSupportCached(
        provider,
        strategy,
        probe?.reasoningOff === true,
        endpoint.baseUrl ?? "",
        config.model,
        probe?.reasoningLevels,
      );
      deps.logger.logSilent(
        "info",
        t("env.reasoning_probe", {
          strategy,
          result: passed === true ? t("env.reasoning_respected") : t("env.reasoning_ignored"),
        }),
      );
      return passed === true;
    } catch (e) {
      deps.logger.logSilent(
        "warn",
        t("env.reasoning_probe_failed", {
          strategy,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      return false;
    }
  })();
  publishReasoningProbe(deps, () => promise);
  void promise.then((passed) => {
    if (sameProbeIdentity(idAtStart, probeIdentityOf(deps.config))) {
      host.probePassed = passed;
    }
  });
}

/**
 * Публикует ленивую reasoning-пробу в ОБЩИЙ бокс (раннеры/субагенты читают
 * его же) и в deps агента-владельца. Один источник — иначе новый раннер,
 * спавненный после свитча, унаследует вердикт прошлого бэкенда.
 */
function publishReasoningProbe(
  deps: SwitchProbeHost["deps"],
  get: () => Promise<boolean>,
): void {
  const box: ProviderProbesBox | undefined = deps.capabilitiesProbeRef;
  if (box) box.reasoningProbe = get;
  deps.reasoningProbe = get;
}

/**
 * Путь `probe: false` (раннеры пула): сеть не трогаем, но чужой вердикт
 * пробы применять нельзя — сбрасываем до следующего резолва.
 */
export function invalidateReasoningProbe(host: SwitchProbeHost): void {
  host.probePassed = false;
  publishReasoningProbe(host.deps, () => Promise.resolve(false));
}

/** Публикует живой результат context-probe в общий бокс для web/раннеров. */
export function publishContextProbe(
  box: ContextProbeBox | undefined,
  value: ContextProbeResult | null,
): void {
  if (box) box.current = value;
}
