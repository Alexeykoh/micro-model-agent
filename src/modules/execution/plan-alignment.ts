/**
 * Гейт выравнивания вызова тула с текущим шагом плана (`execution/module.ts`,
 * INV-23): off-path-варнинг для файл-мутирующих тулов вне текущего/закрытых
 * шагов. Вынесено из класса `ExecutionModule`.
 */
import { t } from "../../i18n/index";
import { toForwardSlash } from "../../tools/path-utils";
import { extractFileLikeTokens, stripUrls } from "../../core/hallucination/js-identifiers";
import type { PlanTracker } from "./tracker";

/**
 * Тулы, которым можно при активном шаге БЕЗ проверки step-alignment. Либо не
 * трогают ФС, либо структурно/read-only инспекции, нужные агенту в любой точке.
 */
const PLAN_ALIGNMENT_EXEMPT_TOOLS = new Set([
  "plan",
  "plan_step",
  "todo",
  "verify",
  "enable_tools",
  "list_dir",
  "read_file",
  "glob",
  "grep",
  "file_info",
  "lsp_check",
  "project_map",
  "chunk_query",
  "web_search",
  "web_fetch",
  "web_browse",
  "recall",
  "search_history",
  "session_info",
  "process_list",
  "process_log",
  "question",
  "approve",
  "load_skill",
]);

/**
 * Каноническая форма файлового токена для alignment: прямые слэши + lowercase.
 * Вызовы тулов несут абсолютные Windows-пути, а шаги плана — относительные;
 * нормализация обеих сторон чинит overlap через substring/`includes`.
 */
function planPathToken(p: string): string {
  return toForwardSlash(p).toLowerCase();
}

/** Мутабельный вид `ExecutionModule`, которым владеет гейт выравнивания. */
export interface PlanAlignmentHost {
  tracker: PlanTracker | null;
}

/**
 * Строковые значения path-like аргументов вызова. Ограничивает off-path чек
 * аргументами, реально именующими файлы, полезную нагрузку не сканирует.
 */
export function pathArgStrings(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (
      !/path|file|dir|src|dst|source|target|input|output|destination|glob|workdir|cwd|command|pattern|query/i.test(
        key,
      )
    ) {
      continue;
    }
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === "string") out.push(v);
    }
  }
  return out;
}

/** Off-path предупреждение для файл-мутирующего тула вне текущего/закрытых шагов. */
export function checkPlanAlignment(
  host: PlanAlignmentHost,
  call: { name: string; arguments: Record<string, unknown> },
): string | null {
  if (!host.tracker) return null;
  const step = host.tracker.getCurrentStep();
  if (!step) return null;

  if (PLAN_ALIGNMENT_EXEMPT_TOOLS.has(call.name)) return null;

  const stepPaths = extractFileLikeTokens(stripUrls(step.description)).map(planPathToken);
  if (stepPaths.length === 0) return null;

  // Инспектируем только path-like аргументы: JSON всего blob'а args скармливал
  // кодовые токены `content` в off-path чек и давал фантомные варнинги.
  const argStr = pathArgStrings(call.arguments).join(" ");
  const callPaths = extractFileLikeTokens(stripUrls(argStr)).map(planPathToken);
  if (callPaths.length === 0) return null;

  // Файлы уже ЗАКРЫТЫХ (done/skipped) шагов — легитимные цели переписи.
  const plan = host.tracker.getPlan();
  const finishedPaths = new Set<string>();
  for (const s of plan.steps) {
    if (s.status === "done" || s.status === "skipped") {
      extractFileLikeTokens(stripUrls(s.description))
        .map(planPathToken)
        .forEach((p) => finishedPaths.add(p));
    }
  }

  // Двунаправленный overlap path-токенов: шаг может звать "main.ts", а тул —
  // "src/main.ts" (или наоборот).
  const matchesAny = (p: string, tokens: string[]) =>
    tokens.some((t) => t === p || t.includes(p) || p.includes(t));
  const finished = [...finishedPaths];

  const offPath = callPaths.some((p) => {
    if (matchesAny(p, finished)) return false;
    return !matchesAny(p, stepPaths);
  });
  if (!offPath) return null;

  return t("exec.plan_warning", {
    step: String(step.id),
    description: step.description,
    tool: call.name,
  });
}
