/**
 * Universal provider context probe: what the backend ACTUALLY serves for
 * `model` right now — a loaded instance length (LM Studio/Ollama/llama.cpp),
 * not the model card maximum.
 *
 * Order: LM Studio native → Ollama native → llama.cpp `/props` →
 * OpenAI-compat `/models` metadata (`context_length`, vLLM `max_model_len`,
 * OpenRouter `top_provider.context_length`) → models.dev catalog (last
 * resort, only for OpenCode Zen/Go whose own `/models` returns bare ids —
 * verified live: `{id, object, created, owned_by}` with no context fields).
 *
 * Returns null when nothing reports a window — the caller keeps the
 * configured `contextWindow` (fail-open).
 */
import type { ModelCapabilities } from "../config/types";
import { lookupModelsDevContext } from "./models-dev";

/** Result of the startup context probe: what the model is ACTUALLY loaded with. */
export interface ContextProbeResult {
  model: string;
  /** Context length of the loaded instance (tokens). */
  actual: number;
}

/** Result of the native model probe: context window + advertised capabilities. */
export interface ModelProbeResult {
  model: string;
  /** Context length of the loaded instance (tokens). */
  contextLength: number;
  /** Advertised capabilities, when the backend reports them (LM Studio). */
  capabilities?: ModelCapabilities;
}

/** Minimal shape of an LM Studio `/api/v1/models` entry we consume. */
interface LmStudioModel {
  key?: string;
  name?: string;
  max_context_length?: number;
  loaded_instances?: Array<{ config?: { context_length?: number } }>;
  capabilities?: { vision?: boolean; trained_for_tool_use?: boolean };
}
interface LmStudioModelsResponse {
  models?: LmStudioModel[];
}

/**
 * Ask the backend's native API (LM Studio `/api/v1/models`) for the loaded
 * model's context length AND advertised capabilities. Context length prefers
 * the running instance (`loaded_instances[].config.context_length`), falling
 * back to `max_context_length`. Capabilities are read from `capabilities`
 * (`vision`, `trained_for_tool_use`) when present — this is the single source
 * of truth that replaces name-based vision guessing.
 *
 * Returns null when the endpoint is unavailable (not LM Studio), the model is
 * not found/loaded, or the request fails — the caller must degrade silently.
 */
export async function probeModel(
  baseUrl: string,
  model: string,
  timeoutMs = 3000,
): Promise<ModelProbeResult | null> {
  const base = baseUrl.replace(/\/$/, "").replace(/\/v1\/?$/, "");
  try {
    const response = await fetch(`${base}/api/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as LmStudioModelsResponse;
    const models = data.models ?? [];
    const found = models.find(
      (m) => m.key === model || m.name === model || (m.key ? model.includes(m.key) : false),
    );
    if (!found) return null;
    const loadedInstance = (found.loaded_instances ?? [])[0];
    const contextLength = loadedInstance?.config?.context_length ?? found.max_context_length;
    if (typeof contextLength !== "number" || contextLength <= 0) return null;

    const raw = found.capabilities;
    let capabilities: ModelCapabilities | undefined;
    if (raw && typeof raw.vision === "boolean") {
      capabilities = { vision: raw.vision };
      if (typeof raw.trained_for_tool_use === "boolean") {
        capabilities.tools = raw.trained_for_tool_use;
      }
    }

    return { model: found.key ?? found.name ?? model, contextLength, capabilities };
  } catch {
    return null;
  }
}

/**
 * Thin context-only projection of {@link probeModel}. Kept for callers that
 * only need the context window (banner, context-probe diagnostics).
 */
export async function getLoadedContextLength(
  baseUrl: string,
  model: string,
  timeoutMs = 3000,
): Promise<ContextProbeResult | null> {
  const probe = await probeModel(baseUrl, model, timeoutMs);
  return probe ? { model: probe.model, actual: probe.contextLength } : null;
}

export interface ProviderContextOpts {
  /** Bearer key for hosted OpenAI-compatible endpoints (OpenRouter, Zen/Go). */
  apiKey?: string;
  timeoutMs?: number;
  /** Registry type (`openai-compat`, `opencode-zen`, …) — gates models.dev. */
  providerType?: string;
}

/** Numeric context-ish fields an OpenAI-compatible `/models` entry may carry. */
const CONTEXT_KEYS = [
  "context_length",
  "context_window",
  "max_context_length",
  "max_context_window",
  "max_model_len",
  "maxModelLen",
  "n_ctx",
  "num_ctx",
  "contextLength",
  "contextWindow",
] as const;

function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * First positive int among known context keys of `obj`. OpenRouter nests the
 * per-endpoint value under `top_provider.context_length`, so one nesting
 * level is covered as well.
 */
function pickContextField(obj: Record<string, unknown>): number | null {
  for (const k of CONTEXT_KEYS) {
    const n = asPositiveInt(obj[k]);
    if (n !== null) return n;
  }
  const top = obj.top_provider ?? obj.topProvider;
  if (top && typeof top === "object") {
    for (const k of CONTEXT_KEYS) {
      const n = asPositiveInt((top as Record<string, unknown>)[k]);
      if (n !== null) return n;
    }
  }
  return null;
}

function matchesModel(entry: Record<string, unknown>, model: string): boolean {
  for (const k of ["id", "name", "model", "key"]) {
    const v = entry[k];
    if (typeof v === "string" && v && (v === model || model.includes(v) || v.includes(model))) {
      return true;
    }
  }
  return false;
}

async function fetchJson(url: string, timeoutMs: number, init?: RequestInit): Promise<unknown | null> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/** Ollama `/api/ps`: context fields of a running instance, if any. */
async function probeOllamaPs(
  origin: string,
  model: string,
  timeoutMs: number,
): Promise<number | null> {
  const ps = await fetchJson(`${origin}/api/ps`, timeoutMs);
  const running = (ps as { models?: Record<string, unknown>[] } | null)?.models;
  if (!Array.isArray(running)) return null;
  const found = running.find(
    (m) => m && typeof m === "object" && matchesModel(m as Record<string, unknown>, model),
  );
  if (!found) return null;
  return pickContextField(found as Record<string, unknown>);
}

function contextFromModelInfo(bag: Record<string, unknown>): number | null {
  for (const [k, v] of Object.entries(bag)) {
    if (k.toLowerCase().includes("context_length") || k.toLowerCase().endsWith("n_ctx")) {
      const n = asPositiveInt(v);
      if (n !== null) return n;
    }
  }
  return pickContextField(bag);
}

/** Ollama `/api/show`: model details, tried under the full and short name. */
async function probeOllamaShow(
  origin: string,
  model: string,
  timeoutMs: number,
): Promise<number | null> {
  const short = model.split(":")[0];
  for (const name of [model, short]) {
    const show = await fetchJson(`${origin}/api/show`, timeoutMs, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const info = (show as { model_info?: Record<string, unknown>; modelInfo?: Record<string, unknown> } | null);
    const bag = info?.model_info ?? info?.modelInfo;
    if (bag && typeof bag === "object") {
      const n = contextFromModelInfo(bag as Record<string, unknown>);
      if (n !== null) return n;
    }
  }
  return null;
}

/** Ollama native API: running instances (`/api/ps`) + details (`/api/show`). */
async function probeOllama(origin: string, model: string, timeoutMs: number): Promise<number | null> {
  // `/api/show` reports the model's context (e.g. `llama.context_length`
  // inside `model_info`) even when `/api/ps` carries no size fields.
  return (
    (await probeOllamaPs(origin, model, timeoutMs)) ??
    (await probeOllamaShow(origin, model, timeoutMs))
  );
}

/** llama.cpp server: single-model `/props` carries the loaded `n_ctx`. */
async function probeLlamaCpp(origin: string, timeoutMs: number): Promise<number | null> {
  const props = await fetchJson(`${origin}/props`, timeoutMs);
  if (!props || typeof props !== "object") return null;
  const bag = props as Record<string, unknown>;
  const direct = pickContextField(bag);
  if (direct !== null) return direct;
  const gen = bag.default_generation_settings;
  if (gen && typeof gen === "object") {
    return pickContextField(gen as Record<string, unknown>);
  }
  return null;
}

/**
 * OpenAI-compatible `/models` with extended metadata. Bare-id servers
 * (plain OpenAI, Zen/Go) carry no context fields → null.
 */
async function probeOpenAICompatModels(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<number | null> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey && apiKey !== "not-needed") headers.Authorization = `Bearer ${apiKey}`;
  const data = await fetchJson(url, timeoutMs, { headers });
  const list = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return null;
  const found = list.find(
    (m): m is Record<string, unknown> => !!m && typeof m === "object" && matchesModel(m as Record<string, unknown>, model),
  );
  if (!found) return null;
  return pickContextField(found);
}

/**
 * models.dev catalog lookup — last resort for OpenCode Zen/Go. Their own
 * `/models` returns bare ids, but models.dev (open-source DB opencode itself
 * uses) lists the `opencode` provider's models under identical ids with
 * `limit.context`. Gated on the Zen URL/type so local backends never touch
 * the network for this.
 */
async function probeModelsDev(
  baseUrl: string,
  model: string,
  providerType: string | undefined,
): Promise<number | null> {
  const isZen =
    providerType === "opencode-zen" ||
    providerType === "opencode-go" ||
    /opencode\.ai\/zen/.test(baseUrl);
  if (!isZen) return null;
  return lookupModelsDevContext(model);
}

export async function probeProviderContext(
  baseUrl: string,
  model: string,
  opts: ProviderContextOpts = {},
): Promise<ContextProbeResult | null> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const origin = baseUrl.replace(/\/$/, "").replace(/\/v1\/?$/, "");
  try {
    const lm = await probeModel(baseUrl, model, timeoutMs);
    if (lm) return { model: lm.model, actual: lm.contextLength };
    const ollama = await probeOllama(origin, model, timeoutMs);
    if (ollama !== null) return { model, actual: ollama };
    const llama = await probeLlamaCpp(origin, timeoutMs);
    if (llama !== null) return { model, actual: llama };
    const compat = await probeOpenAICompatModels(baseUrl, model, opts.apiKey, timeoutMs);
    if (compat !== null) return { model, actual: compat };
    const catalog = await probeModelsDev(baseUrl, model, opts.providerType);
    if (catalog !== null) return { model, actual: catalog };
  } catch {
    // Fail-open: any probe error keeps the configured contextWindow.
  }
  return null;
}
