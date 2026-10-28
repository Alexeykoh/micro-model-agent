// Контракты верификации шагов: file-exists/command/manual/http + парсер.
/**
 * Контракты верификации шагов ("checks").
 *
 * Check — однострочный контракт на шаг, объявляется при create/re-plan.
 * Четыре префикса:
 * - "file-exists:<path>" — жёстко проверяет StepVerifier на done;
 * - "command:<cmd>" — точная команда-доказательство шага (self-certified);
 * - "manual:<text>" — проверка глазами для UI/визуалки (self-certified);
 * - "http:<url>[~<подстрока>]" — GET-проба, исполняется на done.
 *
 * Доказательства делятся на статические (компилируется) и поведенческие
 * (работает). Шаг, меняющий поведение/UI, статикой не подтверждается —
 * см. `checkDoneEvidence` и спеку `2026-10-28-turn-runtime-gate-design.md`.
 *
 * Чистые хелперы, общие для валидатора (module.parseChecks) и done-gate
 * (plan-actions.updateStep).
 */
import { t } from "../../i18n/index";
import type { ToolResult } from "../../tools/types";
import { runHttpCheck } from "./http-check";

/** Вид контракта: файл, команда, ручная проверка, http-проба. */
export type CheckKind = "file" | "command" | "manual" | "http";

/** Класс доказательства: статика (компилируется) или поведение (работает). */
export type EvidenceClass = "static" | "behavioral";

/** Распарсенный check: вид + цель. */
export interface ParsedCheck {
  kind: CheckKind;
  /** Путь после "file-exists:", команда после "command:", текст после "manual:", url после "http:". */
  target: string;
}

const PREFIXES: Array<{ prefix: string; kind: CheckKind }> = [
  { prefix: "file-exists:", kind: "file" },
  { prefix: "command:", kind: "command" },
  { prefix: "manual:", kind: "manual" },
  { prefix: "http:", kind: "http" },
];

/**
 * Команды, доказывающие только статику: сборка/типы/линт. Список фиксированный
 * (INV-G3): новую «статическую» команду добавляют сюда, а не угадывают regex'ом.
 */
const BUILD_COMMANDS = new Set([
  "build",
  "tsc",
  "typecheck",
  "lint",
  "eslint",
  "biome",
  "prettier",
  "check",
]);

/**
 * Признаки шага, меняющего поведение: правка UI/экрана/стилей. Сравнение по
 * словам, а не по подстроке: `build` содержит «ui», и подстрочный матч ложно
 * блокировал обычные build-шаги.
 */
const BEHAVIOR_STEMS_EN = ["component", "page", "screen", "layout", "style"];
const BEHAVIOR_STEMS_RU = ["стил", "компонент", "страниц", "экран", "интерфейс", "вёрстк", "верстк"];

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

/** Имена раннеров, которые не являются доказательством сами по себе. */
const RUNNERS = new Set(["npx", "bunx", "pnpm", "yarn", "bun", "npm", "deno"]);

/** Слова-кандидаты команды: без раннера и `run`, первые три значимых. */
function commandCandidates(command: string): string[] {
  const words = command.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  const head = (words[i] || "").toLowerCase().replace(/\.(cmd|exe)$/, "");
  if (RUNNERS.has(head)) i++;
  if ((words[i] || "").toLowerCase() === "run") i++;
  const out: string[] = [];
  for (let k = 0; k < 3 && i + k < words.length; k++) {
    const w = words[i + k];
    if (!w || w.startsWith("-")) break;
    out.push((w.split(/[\\/]/).pop() || w).toLowerCase().replace(/\.(cmd|exe|ps1|sh)$/, ""));
  }
  return out;
}

/** Класс доказательства для распарсенного check. */
export function classifyCheck(parsed: ParsedCheck): EvidenceClass {
  switch (parsed.kind) {
    case "file":
      return "static";
    case "command":
      return commandCandidates(parsed.target).some((w) => BUILD_COMMANDS.has(w))
        ? "static"
        : "behavioral";
    case "manual":
    case "http":
      return "behavioral";
  }
}

/** True, если описание шага говорит о поведении/UI (по словам). */
export function isBehaviorStep(description: string): boolean {
  const words = description.toLowerCase().split(/[^a-zа-яё0-9]+/);
  return words.some(
    (w) =>
      w === "ui" ||
      BEHAVIOR_STEMS_EN.some((s) => w.startsWith(s)) ||
      BEHAVIOR_STEMS_RU.some((s) => w.startsWith(s)),
  );
}

export interface StepEvidenceTarget {
  description: string;
  check?: string;
}

/**
 * Проверка check-контракта на done для не-файловых видов.
 *
 * Возвращает `null`, если дополнительных требований нет (caller ставит
 * self-certified заметку), либо готовый результат: `blocked` — отказ,
 * иначе текст заметки.
 */
export async function checkDoneEvidence(
  parsed: ParsedCheck,
  target: StepEvidenceTarget,
  stepId: number,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ note: string; blocked: ToolResult | null } | null> {
  if (parsed.kind === "http") {
    const res = await runHttpCheck(parsed.target, { fetchImpl: opts.fetchImpl });
    if (res.ok) {
      return {
        note: `\n${t("plan.http_ok", { check: target.check || "", status: String(res.status ?? 0) })}`,
        blocked: null,
      };
    }
    return {
      note: "",
      blocked: {
        success: false,
        output: t("plan.http_failed", {
          step: String(stepId),
          check: target.check || "",
          detail: res.reason || "failed",
        }),
      },
    };
  }
  // Шаг меняет поведение, а доказательство — статика: сборка зелёная, страница
  // может быть пустой (волна 21). Требуем поведенческий контракт.
  if (classifyCheck(parsed) === "static" && isBehaviorStep(target.description)) {
    return {
      note: "",
      blocked: {
        success: false,
        output: t("plan.check_need_behavior", {
          step: String(stepId),
          check: target.check || "",
        }),
      },
    };
  }
  return null;
}
