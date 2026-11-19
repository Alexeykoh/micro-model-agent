// Проекция путей для DLP: границы, относительный workspace-путь, hidden-glob.
import { resolve } from "node:path";
import type { PolicyContext } from "./context";
import { decodePercentText } from "./detectors/joined";
import { matchAnyGlob, relativeTo } from "./path-policy";
import type { DataPolicyConfig, EgressTarget } from "./types";

/** Найти границу пути после `pos` (пробел/кавычка/запятая/закрывающая скобка). */
export function pathEnd(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && !/[\s"'`),;\]}]/.test(text[i])) i++;
  // Точка/запятая в конце предложения — не часть пути (`Workspace: /workspace.`).
  while (i > pos && /[.,;!?]$/.test(text.slice(pos, i)) && (i === text.length || /\s/.test(text[i]))) {
    i--;
  }
  return i;
}

/**
 * Путь под baseDir → относительный (`src/a.ts`, для корня `.`); иначе null.
 * Нормализует разделители и регистр для сравнения, но возвращает forward-slash
 * остаток: его принимают файловые тулы и на POSIX, и на Windows.
 */
export function relativeToBase(pathText: string, baseDir: string): string | null {
  const p = pathText.replace(/\\/g, "/");
  const b = baseDir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!b) return null;
  const ci = process.platform === "win32";
  const pc = ci ? p.toLowerCase() : p;
  const bc = ci ? b.toLowerCase() : b;
  if (pc === bc) return ".";
  if (!pc.startsWith(`${bc}/`)) return null;
  const rel = p.slice(b.length + 1).replace(/^\/+/, "");
  return rel.length > 0 ? rel : ".";
}

/**
 * Путь скрыт от этой цели по glob-списку? `apiHiddenGlobs` — для API-клиента,
 * `providerBlockGlobs` — для внешнего провайдера (D2). Скрытый путь маскируется
 * целиком, а не только корнем: иначе в `tool_start.args`/`tool_end.output`
 * остаётся хвост `<PATH>\secret\a.txt`.
 */
export function pathHiddenByPolicy(
  pathText: string,
  config: DataPolicyConfig,
  target: EgressTarget,
  ctx: PolicyContext,
): boolean {
  const globs =
    target.kind === "api"
      ? config.apiHiddenGlobs
      : target.trusted
        ? []
        : config.providerBlockGlobs;
  if (!globs.length) return false;
  // Границы сравниваем по нормализованному пути: percent-encoding и удвоенные
  // обратные слэши (JSON) не должны прятать скрытый файл от glob-матчинга.
  const decoded = decodePercentText(pathText).replace(/\\\\/g, "\\");
  const rel = relativeTo(ctx.baseDir, resolve(ctx.baseDir, decoded));
  return matchAnyGlob(rel, globs) !== undefined;
}
