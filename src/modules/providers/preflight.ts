import { errMsg } from "../../utils";

export interface PreflightConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type PreflightReason = "ok" | "unreachable" | "no-model" | "timeout";

export interface PreflightResult {
  ok: boolean;
  reason: PreflightReason;
  ms: number;
}

export interface PreflightOptions {
  timeoutMs?: number;
  /** Test seam: returns non-empty text when the model responds. */
  probe?: (cfg: PreflightConfig, timeoutMs: number) => Promise<string>;
}

/** Minimal, cheap chat probe: confirms the selected model is loaded. */
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
    if (!resp.ok) return "";
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    };
    const msg = data.choices?.[0]?.message;
    return msg?.content || msg?.reasoning_content || "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Confirm the provider answers and the selected model is loaded. Uses a single
 * max_tokens=1 chat call (negligible cost). Never hangs: bounded by timeoutMs.
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
