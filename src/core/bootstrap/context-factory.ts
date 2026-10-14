import { isAbsolute, join, relative, resolve } from "node:path";
import { ContextManager } from "../context/manager";
import { TokenCounter } from "../../llm/token-counter";
import type { AppConfig } from "../../config/types";

/** Дефолт леджера — внутри `.mma/` (gitignored), не в корне репозитория. */
const DEFAULT_NOTES = ".mma/NOTES.md";

/**
 * Приводит `notesPath` к абсолютному пути, гарантированно лежащему внутри
 * `baseDir` (стиль containment — `modules/artifacts/store.ts`). Выход за корень
 * (`..`, абсолютный путь вне) отвергается с фолбэком на `<baseDir>/.mma/NOTES.md`.
 */
export function containedNotesPath(baseDir: string, notesPath: string): string {
  const root = resolve(baseDir);
  const abs = resolve(root, notesPath);
  const rel = relative(root, abs);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  return inside ? abs : join(root, DEFAULT_NOTES);
}

/**
 * Создаёт ContextManager и подключает durable леджер адресов (OO-3): путь из
 * `contextBudget.notesPath` (содержится внутри `baseDir`), ёмкость из `ledgerMax`.
 * Вынесено в фабрику, чтобы bootstrap-раннеры не разрастались сверх потолков
 * `.arch-allowlist.json` (правило ≤300 строк / ceilings only shrink).
 */
export function createContextManager(config: AppConfig, baseDir: string): ContextManager {
  const manager = new ContextManager(
    config.contextWindow,
    config.contextBudget,
    new TokenCounter(config.model),
  );
  manager.configureLedger(
    containedNotesPath(baseDir, config.contextBudget.notesPath ?? DEFAULT_NOTES),
    config.contextBudget.ledgerMax ?? 200,
  );
  return manager;
}
