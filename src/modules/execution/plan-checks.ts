// Контракты верификации шагов: file-exists/command/manual + парсер.
/**
 * Контракты верификации шагов ("checks").
 *
 * Check — однострочный контракт на шаг, объявляется при create/re-plan.
 * Три префикса:
 * - "file-exists:<path>" — жёстко проверяет StepVerifier на done;
 * - "command:<cmd>" — точная команда-доказательство шага (self-certified);
 * - "manual:<text>" — проверка глазами для UI/визуалки (self-certified).
 *
 * Чистые хелперы, общие для валидатора (module.parseChecks) и done-gate
 * (plan-actions.updateStep).
 */

/** Вид контракта: файл, команда, ручная проверка. */
export type CheckKind = "file" | "command" | "manual";

/** Распарсенный check: вид + цель. */
export interface ParsedCheck {
  kind: CheckKind;
  /** Путь после "file-exists:", команда после "command:", текст после "manual:". */
  target: string;
}

const PREFIXES: Array<{ prefix: string; kind: CheckKind }> = [
  { prefix: "file-exists:", kind: "file" },
  { prefix: "command:", kind: "command" },
  { prefix: "manual:", kind: "manual" },
];

/** Парсит строку check. Null, если префикс неизвестен/нет или цель пуста. */
export function parseCheck(check: string): ParsedCheck | null {
  const trimmed = check.trim();
  for (const { prefix, kind } of PREFIXES) {
    if (trimmed.toLowerCase().startsWith(prefix)) {
      const target = trimmed.slice(prefix.length).trim();
      if (!target) return null;
      return { kind, target };
    }
  }
  return null;
}

/** True, если строка check — well-formed контракт. */
export function isValidCheck(check: unknown): check is string {
  return typeof check === "string" && parseCheck(check) !== null;
}
