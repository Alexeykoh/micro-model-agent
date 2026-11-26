/**
 * Асинхронная предзагрузка HTTPS-источников инструкций. Синхронный загрузчик
 * инструкций читает готовые блоки из кеша, поэтому формат промпта и порядок
 * bootstrap-фаз не меняются. Источник проходит SSRF-проверку и таймаут 5 с;
 * приватный адрес отклоняется до сетевого вызова.
 */
import { estimateTokens } from "../../llm/token-counter";
import type { NetworkSecurityConfig } from "../../config/types";
import { fetchValidated } from "../../modules/security/network-validator";
import type { DnsResolver } from "../../modules/security/dns-guard";
import type { PromptBlock } from "../types";

const FETCH_TIMEOUT_MS = 5_000;
const cache = new Map<string, PromptBlock>();

/** Готовый блок источника по URL (только из предзагрузки). */
export function remoteInstructionBlock(url: string): PromptBlock | undefined {
  return cache.get(url);
}

/** Сбросить кеш одного источника (тесты и явный reload). */
export function forgetRemoteInstruction(url: string): void {
  cache.delete(url);
}

function labelOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `instructions (${parsed.host}${parsed.pathname})`;
  } catch {
    return `instructions (${url})`;
  }
}

/**
 * Загрузить HTTPS-источники в кеш. Возвращает списки загруженных и отклонённых
 * URL — отказ не остаётся незамеченным (виден вызывающему и тесту).
 */
export async function preloadRemoteInstructions(
  sources: readonly string[],
  network?: NetworkSecurityConfig,
  resolver?: DnsResolver,
): Promise<{ loaded: string[]; blocked: string[] }> {
  const loaded: string[] = [];
  const blocked: string[] = [];
  for (const raw of sources) {
    if (!/^https:\/\//i.test(raw)) continue;
    // Удалённые инструкции попадают в системный промпт — SSRF-политика
    // обязательна даже если общая сетевая защита отключена пользователем.
    const policy: NetworkSecurityConfig = {
      enabled: true,
      deniedDomains: network?.deniedDomains ?? [],
      allowedDomains: network?.allowedDomains ?? [],
      requestTimeout: network?.requestTimeout ?? FETCH_TIMEOUT_MS,
      maxResponseSize: network?.maxResponseSize ?? 1024 * 1024,
      ...(network?.allowPrivateOutbound !== undefined
        ? { allowPrivateOutbound: network.allowPrivateOutbound }
        : {}),
      ...(network?.allowLoopback !== undefined ? { allowLoopback: network.allowLoopback } : {}),
    };
    try {
      // fetchValidated повторно проверяет каждый хоп редиректа против SSRF.
      const { response } = await fetchValidated(
        raw,
        policy,
        { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
        fetch,
        resolver,
      );
      if (!response.ok) {
        blocked.push(raw);
        continue;
      }
      const content = (await response.text()).trim();
      if (!content) continue;
      cache.set(raw, {
        source: "agents-md",
        label: labelOf(raw),
        content,
        priority: "high",
        essential: false,
        estimatedTokens: estimateTokens(content),
        kind: "instructions",
      });
      loaded.push(raw);
    } catch {
      blocked.push(raw);
    }
  }
  return { loaded, blocked };
}
