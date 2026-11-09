/**
 * Файловое чтение/запись чекпоинта хода (durable state 2/4). Вынесено из
 * `store.ts` (попелка 300): атомарный write temp+rename, шифр при включённой
 * опции. Fail-open: битый/чужая версия → null.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { parseTurnCheckpoint, type TurnCheckpoint } from "./checkpoint";
import type { SessionFileEncryptor } from "../security/session-encryption";

/** Путь чекпоинта в каталоге сессии. */
export function checkpointPathOf(sessionDir: string): string {
  return join(sessionDir, "checkpoint.json");
}

/** Атомарная запись чекпоинта (tmp + rename; mode 0600). */
export function saveCheckpointFile(
  sessionDir: string,
  checkpoint: TurnCheckpoint,
  encryptor: SessionFileEncryptor | null,
): void {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const target = checkpointPathOf(sessionDir);
  const content = JSON.stringify(checkpoint, null, 2);
  const body = encryptor?.isEnabled() ? encryptor.encryptFileContent(content) : content;
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, target);
}

/** Чтение чекпоинта; нет/битая/чужая версия — null. */
export function loadCheckpointFile(
  sessionDir: string,
  encryptor: SessionFileEncryptor | null,
): TurnCheckpoint | null {
  const path = checkpointPathOf(sessionDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const content = encryptor?.isEnabled() ? encryptor.decryptFileContent(raw) : raw;
    return parseTurnCheckpoint(content);
  } catch {
    return null;
  }
}
