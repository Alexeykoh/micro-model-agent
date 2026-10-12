/**
 * Валидация пер-шаговых аргументов плана (`execution/module.ts`, INV-23):
 * `kinds` (create/delete) и `checks` (file-exists:/command:/manual:). Чистые
 * функции без состояния. Вынесено из класса `ExecutionModule`.
 */
import { t } from "../../i18n/index";
import { isValidCheck } from "./plan-checks";
import type { StepKind } from "./planner";

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
 * Валидирует `checks` для create/re-plan. Checks НЕОБЯЗАТЕЛЬНЫ: без массива —
 * self-certified `manual:<шаг>`. Мисматч длины — авто-ремонт (паддинг/обрезка).
 * Префиксы валидируются через `isValidCheck` (см. plan-checks.ts).
 */
export function parseChecks(
  args: Record<string, unknown>,
  steps: string[],
): { checks: string[] | null; error: string | null } {
  if (args.checks === undefined) {
    return { checks: steps.map((s) => `manual:${s.trim().slice(0, 60)}`), error: null };
  }
  if (!Array.isArray(args.checks)) {
    return { checks: null, error: t("plan.checks_not_array") };
  }
  const raw = args.checks.map(String);
  if (raw.length !== steps.length) {
    // Авто-ремонт вместо отказа: паддинг self-certified `manual:` и обрезка
    // лишних (отказ заставлял слабую модель бросить планирование целиком).
    const repaired = steps.map((s, i) => raw[i] ?? `manual:${s.trim().slice(0, 60)}`);
    const bad = repaired.filter((c) => !isValidCheck(c));
    if (bad.length > 0) {
      return { checks: null, error: t("plan.checks_invalid", { kinds: bad.slice(0, 3).join("; ") }) };
    }
    return { checks: repaired, error: null };
  }
  const bad = raw.filter((c) => !isValidCheck(c));
  if (bad.length > 0) {
    return { checks: null, error: t("plan.checks_invalid", { kinds: bad.slice(0, 3).join("; ") }) };
  }
  return { checks: raw.map((c) => c.trim()), error: null };
}
