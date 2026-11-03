// Разбор и проверка machine-readable success_criteria (>300-строчный шов verifier).
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { t } from "../../i18n/index";

/** Один пункт проверки: прошёл ли + сообщение. */
export interface VerificationItem {
  passed: boolean;
  message: string;
}

/** Результат проверки machine-readable success_criteria одной подзадачи. */
export interface CriteriaResult {
  errors: string[];
  /** LLM-only критерии (не машиночитаемые) — отдаются варнингами. */
  warnings: string[];
  details: VerificationItem[];
}

/** Зависимости проверки критериев: путь проекта, файлы и запуск команд. */
export interface CriteriaDeps {
  baseDir: string;
  checkFileExists(path: string): Promise<VerificationItem>;
  run(command: string, cwd: string, timeoutMs: number): Promise<unknown>;
}

/** Критерии: `file-exists:`, `substring-in-file:`, `command-exit-0:`; прочее — warning. */
export async function evaluateCriteria(
  owner: { id: string; check?: string },
  deps: CriteriaDeps,
): Promise<CriteriaResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const details: VerificationItem[] = [];

  for (const criterion of [owner.check].filter((c): c is string => !!c)) {
    const sep = criterion.indexOf(":");
    if (sep <= 0) {
      warnings.push(`Step "${owner.id}": non-machine criterion "${criterion}" (LLM-only)`);
      continue;
    }
    const kind = criterion.slice(0, sep);
    const rest = criterion.slice(sep + 1);

    if (kind === "file-exists") {
      const check = await deps.checkFileExists(rest);
      details.push(check);
      if (!check.passed) errors.push(`[${owner.id}] ${check.message}`);
      continue;
    }

    if (kind === "substring-in-file") {
      const colon = rest.indexOf(":");
      if (colon <= 0) {
        warnings.push(`Step "${owner.id}": malformed substring-in-file criterion "${criterion}"`);
        continue;
      }
      const path = rest.slice(0, colon);
      const needle = rest.slice(colon + 1);
      const resolved = resolve(deps.baseDir, path);
      if (!existsSync(resolved)) {
        const item = { passed: false, message: t("verify.file_not_found", { path }) };
        details.push(item);
        errors.push(`[${owner.id}] ${item.message}`);
        continue;
      }
      const content = readFileSync(resolved, "utf-8");
      const passed = content.includes(needle);
      details.push({ passed, message: `substring "${needle}" in ${path}: ${passed}` });
      if (!passed) errors.push(`[${owner.id}] "${needle}" not found in ${path}`);
      continue;
    }

    if (kind === "command-exit-0") {
      try {
        await deps.run(rest, deps.baseDir, 30_000);
        details.push({ passed: true, message: `command ok: ${rest}` });
      } catch (e: any) {
        const item = {
          passed: false,
          message: `command failed: ${rest} (${String(e.message).slice(0, 200)})`,
        };
        details.push(item);
        errors.push(`[${owner.id}] ${item.message}`);
      }
      continue;
    }

    warnings.push(`Step "${owner.id}": unknown criterion kind "${kind}" (LLM-only)`);
  }

  return { errors, warnings, details };
}
