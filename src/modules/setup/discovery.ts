// Discovery провайдеров для first-run визарда: скан локальных портов, модели, chat-проба.
/**
 * Хелперы discovery провайдеров для first-run визарда.
 * Вынесены как есть (минус терминальный UI) из `src/cli/setup.ts`, чтобы
 * браузерный визард переиспользовал ту же логику проб. Чисто сетевые хелперы:
 * ни терминала, ни output-канала.
 */
import { probeChat } from "../providers/preflight";
import { errMsg } from "../../utils";
import {
  SETUP_SCAN_TIMEOUT_MS as SCAN_TIMEOUT_MS,
  SETUP_MODELS_TIMEOUT_MS as MODELS_TIMEOUT_MS,
  SETUP_CHAT_TIMEOUT_MS as CHAT_TIMEOUT_MS,
} from "../../config/timeouts";

/** Локальные серверы для скана. */
const KNOWN_PORTS = [
  { port: 1234, label: "LM Studio" },
  { port: 11434, label: "Ollama" },
  { port: 8080, label: "vLLM / custom" },
  { port: 4891, label: "GPT4All" },
];

/** Проба известных локальных портов на OpenAI-совместимый `/v1/models`. */
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
      /* порт недоступен */
    }
  }
  return found;
}

/** Id моделей из OpenAI-совместимого `/models`; любая неудача — []. */
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

/** Результат chat-пробы: доступность, задержка и длина ответа. */
export interface ChatProbeResult {
  ok: boolean;
  latencyMs: number;
  replyChars: number;
  /** Причина отказа (HTTP-статус и тело), если провайдер не ответил. */
  error?: string;
}

/** Дешёвая chat-проба с метриками. Не бросает. */
export async function testProviderChatResult(
  apiBase: string,
  apiKey: string,
  model: string,
  providerType?: string,
): Promise<ChatProbeResult> {
  const started = Date.now();
  try {
    const reply = await probeChat(
      { baseUrl: apiBase, apiKey, model, providerType },
      CHAT_TIMEOUT_MS,
    );
    return {
      ok: reply !== "",
      latencyMs: Date.now() - started,
      replyChars: reply.length,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      replyChars: 0,
      error: errMsg(err),
    };
  }
}

/** Дешёвая chat-проба: `true`, если модель отвечает. Не бросает. */
export async function testProviderChat(
  apiBase: string,
  apiKey: string,
  model: string,
  providerType?: string,
): Promise<boolean> {
  return (await testProviderChatResult(apiBase, apiKey, model, providerType)).ok;
}
