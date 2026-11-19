// Проверка изменённых файлов для панели LSP: bounded очередь (последовательно),
// общий бюджет времени и честный отказ, если git/репозитория нет.
import { resolve } from "path";
import { getServerForFile } from "./config";
import { listChangedFiles } from "./changed";
import { runWebCheck, type WebCheckDeps, type WebCheckResult } from "./web-check";

/** Пер-файловый бюджет в пакетной проверке (панель не ждёт 15 с на каждый). */
export const CHANGED_FILE_TIMEOUT_MS = 6000;
/** Общий бюджет пакета: лучше показать часть, чем держать запрос минуту. */
export const CHANGED_TOTAL_BUDGET_MS = 20_000;

export interface ChangedCheckResult {
  ok: boolean;
  /** `git-unavailable` | `no-changes`. */
  error?: string;
  files: WebCheckResult[];
  truncated?: boolean;
  ms?: number;
}

export interface ChangedCheckDeps extends WebCheckDeps {
  /** Тест-шов: список изменённых файлов (sync или async). */
  listChanged?: () => string[] | Promise<string[]>;
  perFileTimeoutMs?: number;
  totalBudgetMs?: number;
}

/** Проверить изменённые файлы по очереди, не выходя за общий бюджет. */
export async function runChangedChecks(deps: ChangedCheckDeps): Promise<ChangedCheckResult> {
  const started = Date.now();
  let paths: string[];
  try {
    paths = await (deps.listChanged ?? (() => listChangedFiles(deps.baseDir)))();
  } catch (e) {
    // Не молчим: без причины «git-unavailable» неотличим от «git сломался».
    deps.logger?.warn(`LSP changed-files list failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, error: "git-unavailable", files: [], ms: Date.now() - started };
  }
  if (paths.length === 0) {
    return { ok: false, error: "no-changes", files: [], ms: Date.now() - started };
  }
  const perFile = deps.perFileTimeoutMs ?? CHANGED_FILE_TIMEOUT_MS;
  const budget = deps.totalBudgetMs ?? CHANGED_TOTAL_BUDGET_MS;
  const files: WebCheckResult[] = [];
  let truncated = false;
  for (const path of paths) {
    if (Date.now() - started > budget) {
      truncated = true;
      break;
    }
    if (!getServerForFile(resolve(deps.baseDir, path), deps.config)) continue;
    files.push(await runWebCheck(path, deps, perFile));
  }
  return { ok: true, files, truncated, ms: Date.now() - started };
}
