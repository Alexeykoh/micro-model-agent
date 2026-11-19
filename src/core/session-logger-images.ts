// Сохранение картинок сессии в `<sessionDir>/images/` с общей ротацией.
// Вынесено из SessionLogger (правило 6): файловый IO и fail-open — здесь,
// политика (когда звать) — в логгере.
import type { SessionManager } from "../modules/session/manager";
import type { Logger } from "../logger/app-logger";
import {
  decodeDataUrl,
  saveToolImage,
  type ToolImageAsset,
  type ToolImageRef,
} from "../modules/session/image-store";

/** Лимиты каталога картинок: число файлов и суммарный размер. */
export interface ImageLimits {
  maxCount: number;
  maxBytes: number;
}

const DEFAULT_LIMITS: ImageLimits = { maxCount: 30, maxBytes: 104_857_600 };

/** Каталог картинок активной сессии; null — нет сессии или включено шифрование. */
function toolImageDir(session: SessionManager | undefined): string | null {
  const meta = session?.getActiveMeta();
  if (!session || !meta || session.isEncryptionEnabled?.()) return null;
  return session.getSessionDirectory(meta.id);
}

/** Запись одного ассета; ошибка — warn и пустой результат (fail-open). */
function saveToolImageSafe(
  dir: string,
  asset: ToolImageAsset,
  limits: ImageLimits,
  logger: Logger | undefined,
): ToolImageRef[] {
  try {
    return [saveToolImage(dir, asset, limits)];
  } catch (err) {
    logger?.warn(
      `failed to persist tool image (${asset.mime}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Сохраняет полноразмерные ассеты тулов с ротацией.
 *
 * Приватность: при включённом шифровании сессии на диск ничего не пишется —
 * веб получает картинку inline (data URL), история — пометку «недоступно».
 * Fail-open: ошибка записи одного ассета не роняет остальные и ход.
 */
export function persistToolImages(
  session: SessionManager | undefined,
  logger: Logger | undefined,
  assets: ToolImageAsset[] | undefined,
  limits: ImageLimits = DEFAULT_LIMITS,
): ToolImageRef[] {
  const dir = toolImageDir(session);
  if (!dir || !assets?.length) return [];
  return assets.flatMap((asset) => saveToolImageSafe(dir, asset, limits, logger));
}

/**
 * Сохраняет картинки пользователя (data URL) в тот же `<sessionDir>/images/`
 * с общей ротацией, что и ассеты тулов. Не-data URL (http) пропускаются —
 * декодировать нечего. Шифрование сессии → [] (live остаётся inline,
 * история — без картинок), как и у тулов. Fail-open.
 */
export function persistUserImages(
  session: SessionManager | undefined,
  logger: Logger | undefined,
  dataUrls: string[] | undefined,
  limits: ImageLimits = DEFAULT_LIMITS,
): ToolImageRef[] {
  const dir = toolImageDir(session);
  if (!dir || !dataUrls?.length) return [];
  const assets: ToolImageAsset[] = [];
  for (const url of dataUrls) {
    try {
      const decoded = decodeDataUrl(url);
      assets.push({ bytes: decoded.bytes, mime: decoded.mime });
    } catch {
      /* not a base64 data URL (e.g. http(s)) — skip */
    }
  }
  return assets.flatMap((asset) => saveToolImageSafe(dir, asset, limits, logger));
}
