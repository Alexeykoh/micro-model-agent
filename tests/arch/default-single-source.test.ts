import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../../src/config/defaults";

/**
 * Gate: у дефолтов конфига один источник правды (W8, класс D).
 *
 * Bootstrap/агент не имеют права собирать СЕКЦИЮ конфига из литералов: копия
 * дефолта молча расходится с `DEFAULTS`. Найденный дефект — `config.reasoning =
 * { overrideCooldown: 3, ... }` в `config-phase.ts`: он разошёлся с дефолтом
 * (5) и потерял `baseline`, при этом `--reasoning` без секции в конфиге включал
 * именно эту ветку. Единственный способ не разойтись — собрать секцию от
 * `DEFAULTS` (спред), а не переписать значения руками.
 *
 * Гейт структурный: проверяет, что объектный литерал, присвоенный секции
 * конфига, содержит спред. Проверка «число равно дефолту» была бы хрупкой —
 * в DEFAULTS есть 0/1/2/5/… и такие литералы встречаются повсюду.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ROOTS = ["src/core/bootstrap", "src/core/agent"];

/** Секции конфига: верхнеуровневые ОБЪЕКТНЫЕ ключи `DEFAULTS`. */
const SECTIONS = Object.entries(DEFAULTS as unknown as Record<string, unknown>)
  .filter(([, v]) => v && typeof v === "object" && !Array.isArray(v))
  .map(([k]) => k);

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Секции конфига, собранные из литералов (нет спреда из `DEFAULTS`/базового
 * конфига) в переданном исходнике. Экспортируется для позитивного контроля.
 */
export function findFabricatedSections(source: string, file: string): string[] {
  const lines = source.split("\n");
  const hits: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    const section = SECTIONS.find((s) =>
      new RegExp(`(^|\\.)${s}\\s*[:=]\\s*\\{[^}]*$`).test(t),
    );
    if (!section) continue;
    // Набираем литерал до баланса фигурных скобок.
    let depth = (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
    let block = t;
    let j = i + 1;
    while (depth > 0 && j < lines.length) {
      block += "\n" + lines[j];
      depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length;
      j++;
    }
    if (!/\.\.\./.test(block)) {
      hits.push(`${relative(REPO_ROOT, file)}:${i + 1} — ${section}: ${t}`);
    }
  }
  return hits;
}

describe("gate: config defaults have a single source (W8)", () => {
  const files = ROOTS.flatMap((r) => walk(join(REPO_ROOT, r)));

  it("scanned enough bootstrap/agent files for the gate to mean anything", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(SECTIONS.length).toBeGreaterThan(10);
  });

  it("detects a fabricated section (positive control, so the gate is not vacuous)", () => {
    const synthetic = [
      "function f(config: AppConfig): void {",
      "  config.reasoning = {",
      '    mode: "high",',
      "    overrideCooldown: 3,",
      "  };",
      "}",
    ].join("\n");
    expect(findFabricatedSections(synthetic, "synthetic.ts").length).toBe(1);
  });

  it("does not flag a section built by spreading the default/base config", () => {
    const synthetic = [
      "return {",
      "  ...base,",
      "  provider: {",
      "    ...base.provider,",
      "    model: config.model,",
      "  },",
      "};",
    ].join("\n");
    expect(findFabricatedSections(synthetic, "synthetic.ts")).toEqual([]);
  });

  it("bootstrap/agent never fabricate a config section from literals", () => {
    const offenders = files.flatMap((f) => findFabricatedSections(readFileSync(f, "utf-8"), f));
    expect(
      offenders,
      "Секция конфига собрана из литералов — она молча разойдётся с DEFAULTS. " +
        `Строй её как { ...DEFAULTS.<секция>, <явные оверрайды> }:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
