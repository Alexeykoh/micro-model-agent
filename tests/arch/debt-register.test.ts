import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    const cells = m[2].split("|").map((c) => c.trim()).filter((c) => c.length > 0);
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
    files.push({ path: relative(REPO_ROOT, full).replace(/\\/g, "/"), text: readFileSync(full, "utf-8") });
  }
}

describe("debt register (rule 9, pay-once)", () => {
  it("the register exists and every row carries id + 5 fields", () => {
    expect(existsSync(REGISTER), "docs/agents/debt.md is missing").toBe(true);
    const rows = parseRegister(readFileSync(REGISTER, "utf-8"));
    expect(rows.length).toBeGreaterThan(0);
    const bad = rows.filter((r) => r.fields < 5).map((r) => r.id);
    expect(bad, `Debt rows missing fields (need why/exit/trigger/date): ${bad.join(", ")}`).toEqual([]);
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
