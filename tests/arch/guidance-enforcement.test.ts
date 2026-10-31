import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCommandAllowed } from "../../src/modules/security/command-validator";
import { DEFAULT_SECURITY_CONFIG } from "../../src/config/security";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Gate: guidance must match enforcement (W1, class B).
 *
 * The prompt told the model one thing and the validator did another. That gap
 * is not a documentation bug: the model was told `;` and `&&` are allowed for
 * chaining, then every chained command was blocked, so it burned turns against a
 * wall it had been explicitly told not to hit. The reverse direction is worse —
 * the validator blocking something the prompt recommends.
 *
 * The gate is bidirectional by construction: every operator declared in any
 * policy list must behave exactly as declared, and the prompt's list must be a
 * subset of what the validator actually enforces.
 */

const bash = DEFAULT_SECURITY_CONFIG.bash;

/** Списки операторов, объявленные в разных местах конфигурации. */
const OPERATOR_LISTS = {
  "config/security.ts (DEFAULT_SECURITY_CONFIG)": DEFAULT_SECURITY_CONFIG.bash.dangerousOperators,
  "command-validator.ts (FALLBACK_BASH_CONFIG)": [
    ">", ">>", "2>", "2>>", "|", "&&", "||", ";", "`", "$(",
  ],
  "security-policies.ts (base)": [">", ">>", "2>", "2>>", "|", "&&", "||", ";", "&", "`", "$("],
  "security-policies.ts (restricted)": ["|", "&&", "||", ";", "&", "`"],
} as const;

/**
 * Расхождения между списками, которые ЗАЯВЛЕНЫ. Политика может быть строже
 * дефолта — это её право; но тогда расхождение должно быть названо, иначе
 * «кто-то когда-то добавил `&`» и есть источник расхождения декларации и
 * enforcement.
 */
const DECLARED_DIVERGENCES: Record<string, string> = {
  "security-policies.ts (base): &": "политика base запрещает одиночный `&` (фоновое выполнение), `&&` легитимен",
  "security-policies.ts (restricted): &": "restricted — та же причина, что и в base",
};

/**
 * Записи списка, которые никогда не срабатывают: их ловит более короткая
 * запись, стоящая раньше. Редирект при этом запрещён — запись просто мёртвая,
 * и её имя не появится ни в одной причине отказа.
 */
const SHADOWED_OPERATORS: Record<string, string> = {
  "2>": "ловится записью `>`, стоящей раньше в списке",
  "2>>": "ловится записью `>>`, стоящей раньше в списке",
};

/** Оператор в команде-минимуме, где и базовая команда безобидна. */
function probe(op: string): string {
  return op === "$(" ? "echo $(whoami)" : op === "`" ? "echo `whoami`" : `echo a ${op} b`;
}

describe("gate: guidance ↔ enforcement (W1)", () => {
  it("every declared operator is actually blocked by the validator", () => {
    // W1a: декларация → поведение. Оператор, объявленный опасным, но проходящий
    // через validateCommand, — это ровно тот дефект B3.
    const unblocked = [...bash.dangerousOperators].filter((op) =>
      isCommandAllowed(probe(op), bash).allowed,
    );
    expect(
      unblocked,
      `Operators declared dangerous but allowed by the validator. Either the list is ` +
        `stale or the enforcement changed:\n${unblocked.join(", ")}`,
    ).toEqual([]);
  });

  it("a chained command is blocked even when the second command is harmless", () => {
    // Дефект B3: цепочка ловилась только если во второй команде стояло «опасное»
    // слово из внутреннего хардкод-списка. `echo a; echo b` не содержала ни
    // одного — и проходила, хотя `;` объявлен опасным.
    for (const command of ["echo a; echo b", "echo a && echo b", "echo a | wc -l"]) {
      expect(isCommandAllowed(command, bash).allowed, command).toBe(false);
    }
  });

  it("a plain command with no operators is still allowed", () => {
    // Обратная сторона: гейт, который блокирует всё, ломает тул так же, как
    // дырявый. `&&` между проверками — не повод запрещать `bun test`.
    expect(isCommandAllowed("bun test", bash).allowed).toBe(true);
    expect(isCommandAllowed("git status --short", bash).allowed).toBe(true);
  });

  it("shell wrappers are blocked and the bash description names them", () => {
    for (const wrapper of ["powershell", "pwsh", "cmd"]) {
      expect(isCommandAllowed(`${wrapper} -Command Get-ChildItem`, bash).allowed, wrapper).toBe(false);
    }
    const bashDescription = readFileSync(
      join(REPO_ROOT, "src", "tools", "bash-description.ts"),
      "utf-8",
    );
    // Платформенный факт живёт в описании тула (одно место), а не в ядре промпта.
    expect(bashDescription.includes("cmd.exe"), "bash-description: не называет cmd.exe").toBe(true);
  });

  it("the prompt never recommends an operator the validator blocks", () => {
    const bashTool = readFileSync(join(REPO_ROOT, "src", "tools", "bash-description.ts"), "utf-8");
    // Операторы из декларации тула выдёргиваются из строки «Chaining and shell
    // operators (| > >> ; &&) are blocked» — без детектора отрицания скан падает
    // на собственном тексте, где они перечислены как ЗАПРЕЩЁННЫЕ. Разделитель —
    // пробел, а не запятая: в декларации их нет, а `split(",")` склеивал
    // «| > >>» в один несуществующий оператор.
    const declared = /operators \(([^)]+)\) are blocked/.exec(bashTool)?.[1] ?? "";
    const operators = declared.split(/\s+/).map((o) => o.trim()).filter(Boolean);
    expect(operators.length, "декларация тула не нашлась — формат изменился?").toBeGreaterThan(0);
    const unknown = operators.filter((op) => !bash.dangerousOperators.includes(op));
    expect(
      unknown,
      `Тул объявляет блокируемыми операторы, которых нет в декларации политики:\n` +
        unknown.join(", "),
    ).toEqual([]);
  });

  it("every policy list diverges from the default only where it is declared", () => {
    const defaults = new Set(bash.dangerousOperators);
    const strays = Object.entries(OPERATOR_LISTS)
      .filter(([name]) => name.startsWith("security-policies"))
      .flatMap(([name, ops]) => ops.filter((op) => !defaults.has(op)).map((op) => `${name}: ${op}`));
    const undeclared = strays.filter((s) => !DECLARED_DIVERGENCES[s]);
    expect(
      undeclared,
      `Расхождение списков операторов не объявлено:\n${undeclared.join("\n")}\n` +
        `Каждое расхождение должно быть в DECLARED_DIVERGENCES с причиной.`,
    ).toEqual([]);
  });

  it("no divergence is declared that the policies no longer have", () => {
    // Заявленное расхождение, которого больше нет, — мёртвая запись: она
    // учит читателя гейта не доверять таблице.
    const defaults = new Set(bash.dangerousOperators);
    const actual = new Set(
      Object.entries(OPERATOR_LISTS)
        .filter(([name]) => name.startsWith("security-policies"))
        .flatMap(([name, ops]) =>
          ops.filter((op) => !defaults.has(op)).map((op) => `${name}: ${op}`),
        ),
    );
    const stale = Object.keys(DECLARED_DIVERGENCES).filter((s) => !actual.has(s));
    expect(stale, `Устаревшие записи DECLARED_DIVERGENCES:\n${stale.join("\n")}`).toEqual([]);
  });

  it("every operator of the default list is actually blocked by the validator", () => {
    // Список растёт, а набор проверок — нет; новый оператор мог бы выпасть из
    // проверки тихо. Проба обязана построить команду с ЛЮБЫМ оператором из
    // декларации и получить запрет.
    const passing = bash.dangerousOperators.filter((op) => isCommandAllowed(probe(op), bash).allowed);
    expect(
      passing,
      `Операторы из декларации, которые валидатор пропускает:\n${passing.join(", ")}`,
    ).toEqual([]);
  });

  it("operators shadowed by an earlier entry are declared as such", () => {
    // `2>` и `2>>` объявлены отдельными элементами, но до них в списке стоят
    // `>` и `>>`, которые ловят ту же перенаправку первыми. Записи работают
    // (редирект запрещён), однако в причине отказа имя мёртвой записи не
    // появится никогда — и это стоит знать, а не обнаруживать при разборе.
    const shadowed = bash.dangerousOperators.filter((op) => {
      const reason = isCommandAllowed(probe(op), bash).reason ?? "";
      return bash.dangerousOperators.some(
        (other) => other !== op && other.length < op.length && op.endsWith(other) && reason.includes(`"${other}"`),
      );
    });
    const undeclared = shadowed.filter((op) => !SHADOWED_OPERATORS[op]);
    expect(
      undeclared,
      `Мёртвые записи списка операторов не объявлены:\n${undeclared.join(", ")}\n` +
        `Каждая должна быть в SHADOWED_OPERATORS с причиной.`,
    ).toEqual([]);
  });

  it("no shadowed entry is declared that the list no longer contains", () => {
    const shadowedNow = new Set(bash.dangerousOperators);
    const stale = Object.keys(SHADOWED_OPERATORS).filter((op) => !shadowedNow.has(op));
    expect(stale, `Устаревшие записи SHADOWED_OPERATORS:\n${stale.join("\n")}`).toEqual([]);
  });
});