// Файловый слой доменов конфига: атомарная запись, слияние, битые файлы.
//
// Вынесено из `domains.ts`: это работа с файлами, а не раскладка AppConfig по
// доменам (правило 6 AGENTS — файл не растёт «заодно»).
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { t } from "../i18n/index";
import { defaultOutputBus } from "../output";
import { regexReviver } from "./utils";

/**
 * Читает файл домена. Битый файл не молча откатывается на дефолты: он
 * переименовывается в `<file>.corrupt-<ts>` (данные не теряются) и читается
 * как пустой (аудит §7.4).
 */
export function readDomainFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw, regexReviver as (key: string, value: unknown) => unknown);
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    const corruptPath = `${filePath}.corrupt-${Date.now()}`;
    try {
      renameSync(filePath, corruptPath);
      defaultOutputBus.log(
        "warn",
        "module:config",
        t("config.parse_failed", { path: corruptPath }),
      );
    } catch {
      /* не смогли переименовать — читаем как пусто */
    }
    return {};
  }
}

/**
 * Слияние «наше / их / база»: ключ, который мы не меняли, берётся с диска
 * (чужое изменение не затирается); ключ, который изменили мы, — наш.
 * Конфликт (меняли и мы, и они) — наша версия: мы писали последними.
 */
export function mergeThreeWay(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...theirs };
  for (const [key, ourValue] of Object.entries(ours)) {
    const theirValue = theirs[key];
    const baseValue = base[key];
    if (sameValue(ourValue, theirValue)) {
      out[key] = ourValue;
      continue;
    }
    if (sameValue(ourValue, baseValue)) {
      // Мы не трогали ключ — оставляем чужое изменение.
      out[key] = theirValue;
      continue;
    }
    out[key] = ourValue;
  }
  return out;
}

/** Равенство значений по JSON. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Атомарная запись файла: tmp → fsync → rename. Обрыв на середине больше не
 * оставляет обрезанный конфиг (аудит §7.4).
 */
export function writeFileAtomic(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp`;
  try {
    const fd = openSync(tmpPath, "w");
    try {
      writeFileSync(fd, content, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* tmp остался — не критично */
    }
    defaultOutputBus.log(
      "error",
      "module:config",
      `[config] failed to write ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
    );
    throw e;
  }
}
