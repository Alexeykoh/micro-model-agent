// DNS-гард SSRF: имя хоста может резолвиться в приватный адрес, и тогда
// «публичный» URL дотягивается до 127.0.0.1 или metadata-эндпоинта облака.
//
// Fail-open при ошибке резолва: офлайн-режим и несуществующие домены не должны
// ломаться из-за гарда (аудит §2.6).
import { lookup } from "node:dns/promises";
import { isIpPrivate } from "./ip-guard";

/** Резолвер хоста: адреса A/AAAA. Подменяется в тестах. */
export type DnsResolver = (host: string) => Promise<Array<{ address: string }>>;

/** Резолвер по умолчанию — системный DNS. */
export const systemResolver: DnsResolver = async (host) => {
  const rows = await lookup(host, { all: true });
  return rows.map((row) => ({ address: row.address }));
};

/** Сколько ждём резолв, прежде чем считать его неудачным (fail-open). */
const RESOLVE_TIMEOUT_MS = 1500;

/** Кэш ответов DNS: хост → приватный ли он (TTL короткий). */
const cache = new Map<string, { private: boolean; at: number }>();

/** TTL кэша: минуты между DNS-резолвами одного хоста. */
const CACHE_TTL_MS = 60_000;

/**
 * Резолвится ли хост в приватный/зарезервированный адрес.
 * true — хотя бы один адрес приватный; false — все публичные; при ошибке
 * резолва — false (fail-open, решение логируется вызывающим).
 */
export async function resolvesToPrivate(
  host: string,
  resolver: DnsResolver = systemResolver,
): Promise<boolean> {
  const key = host.toLowerCase();
  const custom = resolver !== systemResolver;
  const cached = custom ? undefined : cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.private;

  let privateHost = false;
  try {
    const addresses = await withTimeout(resolver(key), RESOLVE_TIMEOUT_MS);
    privateHost = addresses.some((a) => isIpPrivate(a.address));
  } catch {
    // Fail-open: офлайн-режим и несуществующие домены не должны ломаться.
    privateHost = false;
  }
  // Ответы подменённого резолвера не кэшируем — иначе тесты и кастомные
  // резолверы видели бы «залипший» ответ.
  if (!custom) cache.set(key, { private: privateHost, at: Date.now() });
  return privateHost;
}

/** Ограничение ожидания: медленный DNS не должен висеть на каждом запросе. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("dns timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
