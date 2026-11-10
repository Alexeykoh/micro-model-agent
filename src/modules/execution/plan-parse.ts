/**
 * Валидация пер-шаговых аргументов плана (`execution/module.ts`, INV-23):
 * `kinds` (create/delete) и `checks` (file-exists:/command:/manual:). Чистые
 * функции без состояния. Вынесено из класса `ExecutionModule`.
 */
import { t } from "../../i18n/index";
import { extractFileLikeTokens, stripUrls } from "../../core/hallucination/js-identifiers";
import { isValidCheck, parseCheck } from "./plan-checks";
import type { StepKind } from "./planner";

export interface ParsedChecks {
  checks: string[] | null;
  error: string | null;
  /** Предупреждения о проверках, не привязанных к своему шагу (дефект D). */
  warnings: string[];
}

/**
 * Валидирует опциональный `kinds` для create/update плана. Возвращает kinds,
 * выровненные по длине шагов, или i18n-строку ошибки. Нет kinds → null.
 */
export function parseKinds(
  args: Record<string, unknown>,
  steps: string[],
): { kinds: StepKind[] | null; error: string | null } {
  if (args.kinds === undefined) return { kinds: null, error: null };
  if (!Array.isArray(args.kinds)) {
    return { kinds: null, error: t("plan.kinds_not_array") };
  }
  const kindsRaw = args.kinds.map(String);
  if (kindsRaw.length !== steps.length) {
    return { kinds: null, error: t("plan.kinds_mismatch") };
  }
  const invalid = kindsRaw.filter((k) => k !== "create" && k !== "delete");
  if (invalid.length > 0) {
    return { kinds: null, error: t("plan.kinds_invalid", { kinds: invalid.join(", ") }) };
  }
  return { kinds: kindsRaw as StepKind[], error: null };
}

/**
 * Относится ли файловая проверка к файлам своего шага (дефект D, спека 0.25.2):
 * сдвинутый массив checks привязывал проверку к чужому шагу, и шаг получал
 * `manual:`-ловушку. Совпадение — по суффиксу пути среди файловых токенов шага
 * (`src/a.ts` и `bicycle-shop/src/a.ts` — один и тот же файл).
 */
function checkMatchesStep(check: string, step: string): boolean {
  const parsed = parseCheck(check);
  if (!parsed || (parsed.kind !== "file" && parsed.kind !== "file-modified")) return true;
  const stepTokens = extractFileLikeTokens(stripUrls(step));
  if (stepTokens.length === 0) return true;
  const target = parsed.target.replace(/\\/g, "/").toLowerCase();
  return stepTokens.some((tok) => {
    const norm = tok.replace(/\\/g, "/").toLowerCase();
    return target.includes(norm) || norm.includes(target);
  });
}

/** Непривязанную проверку не принимаем: заменяем на self-certified manual:. */
function bindChecks(checks: string[], steps: string[], warnings: string[]): string[] {
  return checks.map((c, i) => {
    const step = steps[i] ?? "";
    if (checkMatchesStep(c, step)) return c;
    warnings.push(t("plan.check_unbound", { step: String(i + 1), check: c }));
    return `manual:${step.trim().slice(0, 60)}`;
  });
}

/**
 * Валидирует `checks` для create/re-plan. Checks НЕОБЯЗАТЕЛЬНЫ: без массива —
 * self-certified `manual:<шаг>`. Мисматч длины — авто-ремонт (паддинг/обрезка).
 * Префиксы валидируются через `isValidCheck` (см. plan-checks.ts).
 */
export function parseChecks(
  args: Record<string, unknown>,
  steps: string[],
): ParsedChecks {
  if (args.checks === undefined) {
    return { checks: steps.map((s) => `manual:${s.trim().slice(0, 60)}`), error: null, warnings: [] };
  }
  if (!Array.isArray(args.checks)) {
    return { checks: null, error: t("plan.checks_not_array"), warnings: [] };
  }
  const raw = args.checks.map(String);
  // Авто-ремонт вместо отказа: паддинг self-certified `manual:` и обрезка
  // лишних (отказ заставлял слабую модель бросить планирование целиком).
  const repaired = raw.length !== steps.length
    ? steps.map((s, i) => raw[i] ?? `manual:${s.trim().slice(0, 60)}`)
    : raw;
  const bad = repaired.filter((c) => !isValidCheck(c));
  if (bad.length > 0) {
    return { checks: null, error: t("plan.checks_invalid", { kinds: bad.slice(0, 3).join("; ") }), warnings: [] };
  }
  const warnings: string[] = [];
  const checks = bindChecks(repaired.map((c) => c.trim()), steps, warnings);
  return { checks, error: null, warnings };
}
