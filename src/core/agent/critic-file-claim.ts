/**
 * BCP-1: детерминированная проверка файловых утверждений критика.
 * Решение принимается по machine-readable путям и tool trail, а не по словам
 * описания шага (правило №10 архитектуры не нарушается).
 */
import { existsSync } from "fs";
import { resolve } from "path";
import type { CriticIssue } from "../modules/critic/types";
import { extractFilePaths } from "../../modules/execution/plan-coverage";

const MISSING_CLAIM =
  /missing|not found|does not exist|no such file|absent|не найден|не существует|отсутствует/i;

const FILE_TOOLS = new Set(["read_file", "write_file", "append_file", "edit_file", "patch_file"]);

export interface FileClaimDeps {
  baseDir?: string;
  toolEvents: Array<{ tool: string; args?: Record<string, unknown>; ok?: boolean }>;
}

function toolSawFile(path: string, deps: FileClaimDeps): boolean {
  const lower = path.replace(/\\/g, "/").toLowerCase();
  return deps.toolEvents.some((e) => {
    if (!e.ok || !FILE_TOOLS.has(e.tool)) return false;
    const raw = e.args?.path;
    return typeof raw === "string" && raw.replace(/\\/g, "/").toLowerCase().includes(lower);
  });
}

function existsOnDisk(path: string, deps: FileClaimDeps): boolean {
  if (!deps.baseDir) return false;
  try {
    return existsSync(resolve(deps.baseDir, path));
  } catch {
    return false;
  }
}

/**
 * Убирает issue, утверждающее отсутствие файла, который реально существует
 * (на диске или в успешном tool trail). Остальные issue проходят без изменений.
 */
export function filterFileClaims(issues: CriticIssue[], deps: FileClaimDeps): CriticIssue[] {
  return issues.filter((issue) => {
    const text = `${issue.claim}\n${issue.problem}\n${issue.evidence ?? ""}`;
    if (!MISSING_CLAIM.test(text)) return true;
    const paths = extractFilePaths(text);
    if (paths.length === 0) return true;
    // Хотя бы один существующий/успешно прочитанный путь опровергает claim.
    const refuted = paths.some((p) => existsOnDisk(p, deps) || toolSawFile(p, deps));
    return !refuted;
  });
}
