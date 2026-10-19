import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture gate (INV-3/INV-D10): слой провайдеров остаётся
 * security-агностичным — он знает только структурный `ProviderEgressGuard`, а
 * реализацию регистрирует bootstrap ДО первой сборки провайдера. Если импорт
 * security появится в провайдерах или регистрация уедет после сборки, дыра
 * откроется молча — поэтому это гейт, а не договорённость.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PROVIDERS_ROOT = resolve(REPO_ROOT, "src/modules/providers");
const IMPORT_SPEC_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

describe("architecture: provider egress seam (INV-3/INV-D10)", () => {
  it("providers never import security", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(PROVIDERS_ROOT)) {
      if (!name.endsWith(".ts")) continue;
      const text = readFileSync(resolve(PROVIDERS_ROOT, name), "utf-8");
      for (const m of text.matchAll(IMPORT_SPEC_RE)) {
        if (m[1].includes("security")) offenders.push(`${name}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("bootstrap installs the guard before the provider build", () => {
    const src = readFileSync(resolve(REPO_ROOT, "src/core/bootstrap.ts"), "utf-8");
    const install = src.indexOf("installEgressGuard(");
    const build = src.indexOf("setupProviderPhase(");
    expect(install).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(install).toBeLessThan(build);
  });
});
