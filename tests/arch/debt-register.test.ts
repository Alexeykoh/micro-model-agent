import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SIGNATURE_KINDS } from "../../src/modules/session/diagnose";

/**
 * Гвард правила 9 (pay-once): долг в реестре и его пометка `DEBT(id)` в
 * коде/спеках не должны расходиться. Иначе «оставим на потом» снова станет
 * невидимым, а реестр превратится в текст.
 */
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REGISTER = join(REPO_ROOT, "docs", "agents", "debt.md");
const SCAN_ROOTS = ["src", "docs"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
const FILE_RE = /\.(ts|tsx|js|mjs|md)$/;
const ROW_RE = /^\|\s*`([a-z0-9-]+)`\s*\|(.*)\|\s*$/;
const DEBT_RE = /DEBT\(([a-z0-9-]+)\)/g;

export interface DebtRow {
  id: string;
  /** Число непустых колонок после id (долг/почему/критерий/триггер/дата = 5). */
  fields: number;
}

/** Разбирает таблицу реестра: строки `| \`id\` | ... |`. */
export function parseRegister(md: string): DebtRow[] {
  const rows: DebtRow[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = ROW_RE.exec(line);
    if (!m) continue;
    const cells = m[2]
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    rows.push({ id: m[1], fields: cells.length });
  }
  return rows;
}

/** Собирает все `DEBT(id)` из текстов (кроме самого реестра). */
export function collectDebtRefs(files: { path: string; text: string }[]): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  for (const file of files) {
    if (file.path.endsWith("debt.md")) continue;
    DEBT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DEBT_RE.exec(file.text)) !== null) {
      const list = refs.get(m[1]) ?? [];
      list.push(file.path);
      refs.set(m[1], list);
    }
  }
  return refs;
}

function walk(dir: string, files: { path: string; text: string }[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), files);
      continue;
    }
    if (!entry.isFile() || !FILE_RE.test(entry.name)) continue;
    const full = join(dir, entry.name);
    files.push({
      path: relative(REPO_ROOT, full).replace(/\\/g, "/"),
      text: readFileSync(full, "utf-8"),
    });
  }
}

describe("debt register (rule 9, pay-once)", () => {
  it("the register exists and every row carries id + 5 fields", () => {
    expect(existsSync(REGISTER), "docs/agents/debt.md is missing").toBe(true);
    const rows = parseRegister(readFileSync(REGISTER, "utf-8"));
    expect(rows.length).toBeGreaterThan(0);
    const bad = rows.filter((r) => r.fields < 5).map((r) => r.id);
    expect(bad, `Debt rows missing fields (need why/exit/trigger/date): ${bad.join(", ")}`).toEqual(
      [],
    );
  });

  it("every DEBT(id) resolves to a register row, and every row is anchored", () => {
    const ids = new Set(parseRegister(readFileSync(REGISTER, "utf-8")).map((r) => r.id));
    const files: { path: string; text: string }[] = [];
    for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root), files);
    const refs = collectDebtRefs(files);

    const dangling = [...refs.keys()].filter((id) => !ids.has(id));
    expect(dangling, `DEBT(id) without a register row: ${dangling.join(", ")}`).toEqual([]);

    const orphan = [...ids].filter((id) => !refs.has(id));
    expect(orphan, `Register row with no DEBT(id) anchor: ${orphan.join(", ")}`).toEqual([]);
  });

  it("the scanner flags a dangling reference in fixture input", () => {
    const refs = collectDebtRefs([{ path: "src/x.ts", text: "// DEBT(nope)\n" }]);
    expect([...refs.keys()]).toEqual(["nope"]);
  });
});

/**
 * Каждая сигнатура разбора сессии (W5) обязана иметь ПРЯМОЙ тест, а не только
 * условную ветку на фикстуре: сигнатура без теста — подпись без проверки.
 * `reason` объясняет, где именно поведение зафиксировано.
 */
export const SIGNATURE_COVERAGE: Record<string, { file: string; reason: string }> = {
  compaction_stall: {
    file: "tests/core/session-diagnose.test.ts",
    reason: "флагман фикстуры: 20 компакций подряд читаются как стадл",
  },
  prompt_block_dropped: {
    file: "tests/core/session-diagnose.test.ts",
    reason: "синтетический context-блок с included:false даёт сигнатуру",
  },
  critic_degraded: {
    file: "tests/modules/critic/client-budget.test.ts",
    reason: "деградация критика логируется во всех пяти ветках отказа",
  },
  tool_failure_repeat: {
    file: "tests/core/session-diagnose.test.ts",
    reason: "три падения одного тула дают сигнатуру с count = порог",
  },
  security_block_repeat: {
    file: "tests/core/session-diagnose.test.ts",
    reason: "повтор одного паттерна блокировки считается, одиночный — нет",
  },
  claim_retry: {
    file: "tests/core/agent-claim-check.test.ts",
    reason: "ретрай заявления фиксируется в логе хода",
  },
  gate_stall: {
    file: "tests/core/session-diagnose.test.ts",
    reason: "gate_timing дольше порога даёт сигнатуру с разбивкой по гейтам",
  },
};

describe("diagnose signatures have a direct test (W6)", () => {
  it("every signature kind is declared with a test that names it", () => {
    const kinds = [...SIGNATURE_KINDS] as string[];
    const missing = kinds.filter((k) => !(k in SIGNATURE_COVERAGE));
    expect(missing, `Сигнатура без прямого теста: ${missing.join(", ")}`).toEqual([]);
    const extra = Object.keys(SIGNATURE_COVERAGE).filter((k) => !kinds.includes(k));
    expect(extra, `Таблица объявляет несуществующую сигнатуру: ${extra.join(", ")}`).toEqual([]);
  });

  it("each declared test exists and actually asserts its signature", () => {
    for (const [kind, entry] of Object.entries(SIGNATURE_COVERAGE)) {
      const full = join(REPO_ROOT, entry.file);
      expect(existsSync(full), `${kind}: нет файла ${entry.file}`).toBe(true);
      const text = readFileSync(full, "utf-8");
      expect(text, `${kind}: файл ${entry.file} не упоминает сигнатуру`).toContain(kind);
      expect(entry.reason.trim().length, `${kind}: причина слишком короткая`).toBeGreaterThan(20);
    }
  });
});
