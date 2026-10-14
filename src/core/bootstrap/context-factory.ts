import { join } from "node:path";
import { ContextManager } from "../context/manager";
import { TokenCounter } from "../../llm/token-counter";
import type { AppConfig } from "../../config/types";

/**
 * Создаёт ContextManager и подключает durable леджер адресов (OO-3): путь из
 * `contextBudget.notesPath` относительно `baseDir`, ёмкость из `ledgerMax`.
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
    join(baseDir, config.contextBudget.notesPath ?? "NOTES.md"),
    config.contextBudget.ledgerMax ?? 200,
  );
  return manager;
}
