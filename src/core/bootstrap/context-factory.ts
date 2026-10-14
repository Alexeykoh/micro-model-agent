import { isAbsolute, join, relative, resolve } from "node:path";
import { ContextManager } from "../context/manager";
import type { ProgressDiagnostic } from "../context/compaction-progress";
import { TokenCounter } from "../../llm/token-counter";
import type { AppConfig } from "../../config/types";
import type { SessionManager } from "../../modules/session/index";

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
 * INV-15: sink «компакция без прогресса» — пишет `context_degraded` в сессию тем
 * же объектом-записью, что `admission_degraded`/`verify_error` (SessionLogger на
 * момент сборки `ContextManager` ещё не создан, поэтому пишем через менеджер).
 *
 * Контракт формы — как у `SessionLogger.appendDiagnostic`: `content` = `cause`,
 * поля `source`/`operation`/`errorKind`/`cause`/`recoverable`. `cause` здесь
 * синтезируется из счётчика и не несёт тул-вывод или данные пользователя, поэтому
 * не требует `redactContextSecrets`; сохраняйте это свойство (иначе сырой текст
 * пойдёт в `session.jsonl` в обход скраба SessionLogger).
 */
export function contextDegradedSink(
  sessionManager: SessionManager,
): (d: ProgressDiagnostic) => void {
  return (d: ProgressDiagnostic) => {
    sessionManager.appendLog({
      ts: new Date().toISOString(),
      type: "context_degraded",
      content: `compaction without ledger progress (${d.compactions} in a row)`,
      source: "core",
      operation: "context.compaction",
      errorKind: "degraded",
      cause: `no ledger progress over ${d.compactions} compactions`,
      recoverable: true,
    });
  };
}

/**
 * Создаёт ContextManager и подключает durable леджер адресов (OO-3): путь из
 * `contextBudget.notesPath` (содержится внутри `baseDir`), ёмкость из `ledgerMax`.
 * Вынесено в фабрику, чтобы bootstrap-раннеры не разрастались сверх потолков
 * `.arch-allowlist.json` (правило ≤300 строк / ceilings only shrink).
 *
 * `sessionManager` (опционально) — для INV-15 sink `context_degraded`.
 */
export function createContextManager(
  config: AppConfig,
  baseDir: string,
  sessionManager?: SessionManager,
): ContextManager {
  const manager = new ContextManager(
    config.contextWindow,
    config.contextBudget,
    new TokenCounter(config.model),
  );
  manager.configureLedger(
    containedNotesPath(baseDir, config.contextBudget.notesPath ?? DEFAULT_NOTES),
    config.contextBudget.ledgerMax ?? 200,
  );
  if (sessionManager) {
    manager.setProgressDiagnosticSink(contextDegradedSink(sessionManager));
  }
  return manager;
}
