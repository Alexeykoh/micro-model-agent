/**
 * Provider discovery helpers for the first-run wizard.
 *
 * Moved verbatim (minus terminal UI) from `src/cli/setup.ts` so the browser
 * wizard can reuse the exact same probing logic. Pure network helpers: no
 * terminal, no output channel.
 */
import { probeChat } from "../providers/preflight";

/** Local servers the scan probes. */
const KNOWN_PORTS = [
  { port: 1234, label: "LM Studio" },
  { port: 11434, label: "Ollama" },
  { port: 8080, label: "vLLM / custom" },
  { port: 4891, label: "GPT4All" },
];

const SCAN_TIMEOUT_MS = 2000;
const MODELS_TIMEOUT_MS = 5000;
const CHAT_TIMEOUT_MS = 10000;

/** Probe well-known local ports for an OpenAI-compatible `/v1/models`. */
export async function scanLocalServers(): Promise<{ label: string; url: string }[]> {
  const found: { label: string; url: string }[] = [];
  for (const { port, label } of KNOWN_PORTS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
      const resp = await fetch(`http://localhost:${port}/v1/models`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (resp.ok) {
        found.push({ label, url: `http://localhost:${port}/v1` });
      }
    } catch {
      /* port not available */
    }
  }
  return found;
}

/** List model ids from an OpenAI-compatible `/models`; `[]` on any failure. */
export async function fetchProviderModels(apiBase: string, apiKey: string): Promise<string[]> {
  try {
    const url = `${apiBase.replace(/\/+$/, "")}/models`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      data?: Array<{ id?: string; name?: string; model?: string }>;
    };
    const list = Array.isArray(data.data) ? data.data : [];
    return list
      .map((m) => m.id || m.name || m.model || "")
      .filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}

/** Cheap chat probe: `true` when the selected model answers. Never throws. */
export async function testProviderChat(
  apiBase: string,
  apiKey: string,
  model: string,
): Promise<boolean> {
  try {
    return (await probeChat({ baseUrl: apiBase, apiKey, model }, CHAT_TIMEOUT_MS)) !== "";
  } catch {
    return false;
  }
}
