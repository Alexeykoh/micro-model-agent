// Сетевые предикаты, общие для `mma web` и `mma serve` (нейтральный runtime-слой).

/** True для loopback-хостов. */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * True, если адрес peer'а — loopback (`127.0.0.0/8`, `::1`, IPv4-mapped).
 * Это клиент локального оператора, а не внешний API-клиент (спека 2026-10-20).
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}
