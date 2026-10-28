// Preflight провайдера: дешёвый chat-probe (max_tokens=1) перед LLM-входами.
import type { ProviderConfig } from "../../config/types";
import { errMsg } from "../../utils";

/** Конфиг preflight-пробы: куда стучаться и какую модель спрашивать. */
export interface PreflightConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Итог пробы: ok / недоступен / нет модели / таймаут. */
export type PreflightReason = "ok" | "unreachable" | "no-model" | "timeout";

/** Результат preflight: успех, причина, длительность в мс. */
export interface PreflightResult {
  ok: boolean;
  reason: PreflightReason;
  ms: number;
}

export interface PreflightOptions {
  timeoutMs?: number;
  /** Тестовый шов: возвращает непустой текст, если модель отвечает. */
  probe?: (cfg: PreflightConfig, timeoutMs: number) => Promise<string>;
}

/** Base URL + ключ активного провайдера (сначала entries, потом legacy). */
export function resolveProviderTarget(provider: {
  active?: string;
  entries?: Array<{ label?: string; type: string; baseUrl: string; apiKey?: string }>;
  type: string;
  baseUrl: string;
  apiKey?: string;
}): { baseUrl: string; apiKey: string } {
  const entries = provider.entries ?? [];
  if (entries.length > 0) {
    const active = provider.active;
    const entry =
      entries.find((e) => (e.label ?? e.type) === active) ??
      entries.find((e) => e.type === active) ??
      entries[0];
    return { baseUrl: entry.baseUrl, apiKey: entry.apiKey ?? "" };
  }
  return { baseUrl: provider.baseUrl, apiKey: provider.apiKey ?? "" };
}

/** Минимальная форма для preflight активного провайдера из конфига. */
export interface PreflightContext {
  config: { provider: ProviderConfig; model: string };
}

/** Резолв активного провайдера из конфига, затем его preflight. */
export function preflightFromConfig(ctx: PreflightContext): Promise<PreflightResult> {
  const target = resolveProviderTarget(ctx.config.provider);
  return preflightProvider({
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    model: ctx.config.model,
  });
}

/**
 * Ответ провайдера получен, но текст пуст: reasoning-модель на `max_tokens: 1`
 * отдаёт пустой `content` (и часто без `reasoning_content`). Это не «модели
 * нет»: незагруженная модель отвечает 4xx, а 200 с `choices[0]` значит, что
 * запрос принят и генерация состоялась.
 */
export const PROBE_ANSWERED = "ok";

/** Минимальная дешёвая chat-проба: подтверждает, что модель загружена. */
export async function probeChat(
  cfg: PreflightConfig,
  timeoutMs: number,
): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: "ok" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    };
    const choice = data.choices?.[0];
    if (!choice) return "";
    const msg = choice.message;
    return msg?.content || msg?.reasoning_content || PROBE_ANSWERED;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Проверить, что провайдер отвечает и модель загружена. Один chat-вызов с
 * max_tokens=1 (стоимость пренебрежима). Не висит: ограничен timeoutMs.
 */
export async function preflightProvider(
  cfg: PreflightConfig,
  opts: PreflightOptions = {},
): Promise<PreflightResult> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const probe = opts.probe ?? probeChat;
  const start = Date.now();
  try {
    const text = await probe(cfg, timeoutMs);
    const ms = Date.now() - start;
    return text ? { ok: true, reason: "ok", ms } : { ok: false, reason: "no-model", ms };
  } catch (err) {
    const ms = Date.now() - start;
    const message = errMsg(err);
    const reason: PreflightReason = /abort|timeout/i.test(message) ? "timeout" : "unreachable";
    return { ok: false, reason, ms };
  }
}
