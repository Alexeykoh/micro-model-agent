// Приватные/зарезервированные IP-адреса (SSRF-гаард).
//
// Вынесено из `network-validator.ts`: тем же правилом пользуется DNS-гард,
// который резолвит имя хоста и спрашивает здесь. Иначе получился бы цикл
// импортов (network-validator → dns-guard → network-validator).

/**
 * Разобрать числовой компонент IP с учётом decimal, hex (0x…) и octal (0…).
 * Не числовой токен — null.
 */
function parseIpNumber(s: string): number | null {
  if (/^0x[0-9a-f]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^0[0-7]+$/.test(s)) return parseInt(s.slice(1), 8);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return null;
}

/** Образуют ли четыре октета приватный/резервный IPv4. */
function isPrivateIpv4(o: number[]): boolean {
  const [a, b = 0, _c = 0, _d = 0] = o;
  if (a === 0) return true; // 0.0.0.0/8 «this network»
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (metadata!)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a >= 224 && a <= 239) return true; // 224/4 multicast
  if (a >= 240) return true; // 240/4 reserved (broadcast 255.255.255.255)
  return false;
}

/**
 * Переписать хвостовой dotted-quad (IPv4-mapped литерал, напр. `::ffff:127.0.0.1`)
 * двумя hex-группами, чтобы общий парсер IPv6 его разобрал.
 */
function normalizeIpv4Tail(input: string): string | null {
  const idx = input.lastIndexOf(":");
  const tail = idx >= 0 ? input.slice(idx + 1) : input;
  if (!tail.includes(".")) return input;
  const oct = tail.split(".").map((d) => parseInt(d, 10));
  if (oct.length !== 4 || oct.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  const hi = (((oct[0] << 8) | oct[1]) & 0xffff).toString(16);
  const lo = (((oct[2] << 8) | oct[3]) & 0xffff).toString(16);
  return `${idx >= 0 ? input.slice(0, idx + 1) : ""}${hi}:${lo}`;
}

/** Развернуть IPv6-литерал (без зоны) в 8 групп; кривой — null. */
function expandIpv6(input: string): number[] | null {
  const normalized = normalizeIpv4Tail(input.split("%")[0]);
  if (normalized === null) return null;
  const h = normalized;
  const parse = (s: string): number[] =>
    s ? s.split(":").filter((x) => x !== "").map((x) => parseInt(x, 16)) : [];
  const [head, tail] = h.split("::");
  let groups: number[];
  if (tail !== undefined) {
    const a = parse(head);
    const b = parse(tail);
    const zeros = 8 - a.length - b.length;
    if (zeros < 0) return null;
    groups = [...a, ...new Array(zeros).fill(0), ...b];
  } else {
    groups = parse(h);
  }
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

/**
 * Приватный/link-local адрес в hostname (SSRF-защита) или нет.
 * Покрывает не только dotted-quad: голые int/hex/octal-кодировки
 * (любой HTTP-клиент декодит их как 32-битный IPv4), короткие квады
 * ("127.1" → 127.0.0.1) и IPv6 — loopback/unspecified/link-local/
 * unique-local/multicast/NAT64 и IPv4-mapped в любой форме раскрытия
 * (старые строковые префиксы пропускали `0:0:0:0:0:0:0:1` и `::ffff:0:7f00:1`).
 */
export function isIpPrivate(hostname: string): boolean {
  const h = hostname.toLowerCase().trim().replace(/^\[|\]$/g, "");

  if (h.includes(":")) {
    const g = expandIpv6(h);
    if (!g) return false;
    // IPv4-mapped/translated (::ffff:a.b.c.d) в любой форме с нулями: старшие
    // 96 бит — нули/ffff, младшие 32 — приватный IPv4.
    const high = g.slice(0, 6);
    if (
      high.some((n) => n === 0xffff) &&
      high.every((n) => n === 0 || n === 0xffff) &&
      isPrivateIpv4([(g[6] >> 8) & 255, g[6] & 255, (g[7] >> 8) & 255, g[7] & 255])
    ) {
      return true;
    }
    // NAT64 64:ff9b::/96 — встроенный IPv4 проверяем отдельно.
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) {
      if (isPrivateIpv4([(g[6] >> 8) & 255, g[6] & 255, (g[7] >> 8) & 255, g[7] & 255])) {
        return true;
      }
    }
    if (g.slice(0, 7).every((n) => n === 0) && g[7] <= 1) return true; // :: и ::1
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
  }

  if (h === "localhost") return true;

  // Голый int/hex/octal: интерпретируется как одно 32-битное слово IPv4.
  if (!h.includes(".")) {
    const n = parseIpNumber(h);
    if (n === null) return false; // доменное имя, не IP
    if (n < 0 || n > 0xffffffff) return false;
    return isPrivateIpv4([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  }

  // Точечная форма: декодим каждую часть (hex/octal-aware); короткие вроде
  // "127.1" добивают пропущенные группы нулями перед последней.
  const parts = h.split(".");
  const nums: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const n = parseIpNumber(parts[i]);
    if (n === null || n > 255) return false; // домен или мусор — не наша забота
    nums.push(n);
  }
  while (nums.length < 4) nums.splice(nums.length - 1, 0, 0);
  if (nums.length !== 4) return false;
  return isPrivateIpv4(nums);
}

/** Является ли строка IP-литералом (а не доменным именем). */
export function isIpLiteral(hostname: string): boolean {
  const h = hostname.toLowerCase().trim().replace(/^\[|\]$/g, "");
  if (h.includes(":")) return expandIpv6(h) !== null;
  return h.split(".").every((part) => part !== "" && parseIpNumber(part) !== null);
}

/**
 * Link-local/metadata-адрес (169.254.0.0/16, а также well-known имена
 * metadata-сервисов облаков). Отличается от «приватного» адреса: локальные
 * провайдеры (Ollama на 127.0.0.1) легальны, а вот адрес метаданных облака —
 * это креды, и пробивать его нельзя.
 */
export function isMetadataHost(hostname: string): boolean {
  const h = hostname.toLowerCase().trim().replace(/^\[|\]$/g, "");
  if (h === "metadata" || h === "metadata.google.internal" || h === "instance-data") return true;
  if (h.includes(":")) {
    const g = expandIpv6(h);
    if (!g) return false;
    // fe80::/10 — link-local IPv6.
    return (g[0] & 0xffc0) === 0xfe80;
  }
  const parts = h.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => parseIpNumber(p));
  if (nums.some((n) => n === null || n > 255)) return false;
  const [a = 0, b = 0] = nums;
  // 169.254/16 — link-local (в т.ч. 169.254.169.254 у облаков).
  if (a === 169 && b === 254) return true;
  // 100.100.100.200 — метаданные Alibaba Cloud.
  if (a === 100 && b === 100 && nums[2] === 100 && nums[3] === 200) return true;
  return false;
}
