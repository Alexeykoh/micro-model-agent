/**
 * Read shapes for the "Model & Provider" settings page of `mma web`.
 *
 * Split out of `providers-api.ts` (rule #1: ≤300 lines/file). Pure
 * config → view projections; no HTTP, no persistence. Secrets are never
 * echoed: the read shape exposes `hasApiKey` instead of the key itself.
 */
import type { AppConfig, ProviderEntry } from "../../config/types";
import { BUILTIN_PROVIDERS } from "../providers/presets";

/** Redacted provider entry rendered by the settings UI. */
export interface ProviderView {
  type: string;
  label: string;
  baseUrl: string;
  contextWindow?: number;
  priority?: number;
  rpm?: number;
  parallel?: number;
  hasApiKey: boolean;
}

/** A builtin provider template offered as a one-click choice in the UI. */
export interface ProviderPresetView {
  /** Unique UI key (`type` for builtins, a stable slug for local presets). */
  id: string;
  /** Registry provider type written to the config. */
  type: string;
  /** Suggested provider name (must stay unique across entries). */
  name: string;
  label: string;
  baseUrl?: string;
}

/**
 * Named local endpoints: same `openai-compat` type, well-known base URLs, so a
 * local setup needs no URL knowledge either. (LM Studio graduated to a real
 * builtin preset — `lmstudio` — and is no longer duplicated here.)
 */
const LOCAL_PRESETS: ProviderPresetView[] = [
  { id: "ollama", type: "openai-compat", name: "ollama", label: "Ollama (localhost:11434)", baseUrl: "http://localhost:11434/v1" },
  { id: "vllm", type: "openai-compat", name: "vllm", label: "vLLM (localhost:8000)", baseUrl: "http://localhost:8000/v1" },
];

/** Builtin presets with their fixed base URLs (hosted providers carry one). */
export function buildProviderPresets(): ProviderPresetView[] {
  const builtin: ProviderPresetView[] = BUILTIN_PROVIDERS.map((spec) => {
    const preset: ProviderPresetView = {
      id: spec.type,
      type: spec.type,
      name: spec.type,
      label: spec.label,
    };
    if (spec.baseUrl) preset.baseUrl = spec.baseUrl;
    return preset;
  });
  return [...builtin, ...LOCAL_PRESETS];
}

/** Normalize `config.provider` into a display list + active name. */
export function buildProviderViews(config: AppConfig): {
  entries: ProviderView[];
  active: string;
  presets: ProviderPresetView[];
} {
  const provider = config.provider;
  const raw: ProviderEntry[] =
    Array.isArray(provider.entries) && provider.entries.length > 0
      ? provider.entries
      : [{ type: provider.type, baseUrl: provider.baseUrl, apiKey: provider.apiKey }];
  const entries = raw.map((e) => {
    const view: ProviderView = {
      type: e.type,
      label: e.label || e.type,
      baseUrl: e.baseUrl,
      hasApiKey: Boolean(e.apiKey),
    };
    if (e.contextWindow !== undefined) view.contextWindow = e.contextWindow;
    if (e.priority !== undefined) view.priority = e.priority;
    if (e.rateLimits) {
      view.rpm = e.rateLimits.maxRequestsPerMinute;
      view.parallel = e.rateLimits.maxParallelTasks;
    }
    return view;
  });
  return { entries, active: provider.active || provider.type, presets: buildProviderPresets() };
}
