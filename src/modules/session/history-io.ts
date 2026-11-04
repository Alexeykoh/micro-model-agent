// Чтение истории сессии с диска: `history.jsonl` и ротированный `<id>.jsonl.gz`.
//
// Вынесено из `store.ts` (правило 6): стор владеет метами и реестром, а разбор
// строк истории — чистая функция над файлом (аудит §7.15).
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { SessionMessage } from "./types";

/** Расшифровка строки, когда включено шифрование файлов сессий. */
export type LineDecryptor = (line: string) => string;

/** Разбор строк: битая строка пропускается, шифрование — best-effort. */
function parseLines(raw: string, decrypt?: LineDecryptor): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let text = line;
    if (decrypt) {
      try {
        text = decrypt(line);
      } catch {
        continue;
      }
    }
    try {
      out.push(JSON.parse(text) as SessionMessage);
    } catch {
      // Битая строка не должна ронять чтение всей истории.
    }
  }
  return out;
}

/** Загрузить историю из `path` (нет файла — `[]`). */
export function readHistoryFile(path: string, decrypt?: LineDecryptor): SessionMessage[] {
  if (!existsSync(path)) return [];
  try {
    return parseLines(readFileSync(path, "utf-8"), decrypt);
  } catch {
    return [];
  }
}

/** История ротированной сессии из `<baseDir>/<id>.jsonl.gz` (нет gz — `[]`). */
export function readRotatedHistory(gzPath: string): SessionMessage[] {
  if (!existsSync(gzPath)) return [];
  try {
    return parseLines(gunzipSync(readFileSync(gzPath)).toString("utf-8"));
  } catch {
    return [];
  }
}
