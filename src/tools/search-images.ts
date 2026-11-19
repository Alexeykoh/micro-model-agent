/**
 * Скачивание картинок выдачи веб-поиска (`webSearch.images`). Серверный
 * прокси-фетч вместо внешнего `<img>` в браузере (политика U2: чужой хост не
 * должен видеть IP/время чтения пользователя; CSP `img-src 'self'` не трогаем).
 * Байты уходят в стандартный пайплайн `ToolResult.imageFiles` → персист →
 * same-origin карточка в веб-ленте.
 */
import { readMmaVersion } from "../core/version";
import type { NetworkSecurityConfig } from "../config/types";
import type { ToolImageAsset } from "../modules/session/image-store";
import { isUrlAllowed } from "../modules/security/network-validator";

/** Миме картинок, которые сохраняем и отдаём (SVG — исполняемый, не берём). */
const IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
]);

/** Потолок на одну картинку выдачи: больше — тихий пропуск, поиск не ломается. */
const MAX_IMAGE_BYTES = 2_000_000;

/**
 * Скачивает до `limit` картинок по URL из выдачи. Каждая проходит тот же
 * сетевой гард, что и поиск/фетч (`isUrlAllowed`); неудача одной ссылки —
 * пропуск, а не ошибка поиска. `fetchImpl` — точка подмены для тестов.
 */
export async function downloadSearchImages(
  urls: string[],
  limit: number,
  networkConfig: NetworkSecurityConfig | undefined,
  requestTimeoutMs?: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolImageAsset[]> {
  const assets: ToolImageAsset[] = [];
  const timeoutMs = requestTimeoutMs ?? networkConfig?.requestTimeout ?? 10000;
  for (const url of urls) {
    if (assets.length >= limit) break;
    if (!isUrlAllowed(url, networkConfig).allowed) continue;
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": `micro-models-agent/${readMmaVersion()}` },
      });
      if (!response.ok) continue;
      const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!IMAGE_MIMES.has(mime)) continue;
      const buf = await response.arrayBuffer();
      if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) continue;
      assets.push({ bytes: new Uint8Array(buf), mime });
    } catch {
      /* необязательная декорация: таймаут/битая ссылка — просто нет картинки */
    }
  }
  return assets;
}
