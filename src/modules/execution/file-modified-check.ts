// Контракт `file-modified:<path>`: снапшот контента на create, проверка на done.
// Вынесено отдельно (правило 6): `verifier.ts` близок к лимиту 300 строк.
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { t } from "../../i18n/index";
import type { PathSecurityConfig } from "../../config/types";
import type { ToolScope } from "../../tools/types";
import { resolveCheckPath } from "./check-path";
import { findExistingFile } from "./auditor";
import type { VerificationItem } from "./verifier-criteria";

/** sha256 контента файла (тот же резолв, что у checkFileExists) или null. */
export function fileContentHash(
  baseDir: string,
  rawPath: string,
  scope?: ToolScope,
  securityConfig?: PathSecurityConfig,
  strict = false,
): { blocked: string | null; hash: string | null } {
  const check = resolveCheckPath(baseDir, rawPath, scope, securityConfig);
  if (check.blocked) return { blocked: check.blocked, hash: null };
  const found = findExistingFile(baseDir, check.path, { mode: strict ? "suffix" : "fuzzy" });
  if (!found) return { blocked: null, hash: null };
  let content: Buffer;
  try {
    content = readFileSync(found);
  } catch {
    return { blocked: null, hash: null };
  }
  return { blocked: null, hash: createHash("sha256").update(content).digest("hex") };
}

/** Снапшот на create/re-plan: хеш, или null если файла ещё нет. */
export function snapshotFile(
  baseDir: string,
  rawPath: string,
  scope?: ToolScope,
  securityConfig?: PathSecurityConfig,
): string | null {
  return fileContentHash(baseDir, rawPath, scope, securityConfig).hash;
}

/**
 * Проверка на done: контент обязан отличаться от снапшота. Создание с нуля
 * (`baseline === null`, файл появился) — изменение; `undefined` (легаси-план
 * без снапшота) доказать нечем — блок с требованием re-plan.
 */
export function checkFileModified(
  baseDir: string,
  rawPath: string,
  baseline: string | null | undefined,
  scope?: ToolScope,
  securityConfig?: PathSecurityConfig,
): VerificationItem {
  if (baseline === undefined) {
    return { passed: false, message: t("verify.file_no_baseline", { path: rawPath }) };
  }
  const current = fileContentHash(baseDir, rawPath, scope, securityConfig, true);
  if (current.blocked) return { passed: false, message: current.blocked };
  if (current.hash === baseline) {
    return { passed: false, message: t("verify.file_not_modified", { path: rawPath }) };
  }
  return { passed: true, message: t("verify.file_modified", { path: rawPath }) };
}
