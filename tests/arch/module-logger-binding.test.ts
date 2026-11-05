import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Gate W4 (INV-15): модульный логгер обязан приходить из `ModuleCtx` (или
 * инъекцией), а не создаваться на уровне модуля. `new Logger(...)` без
 * `setLogDir/setSessionDir` пишет только в терминал — warn модуля терялся и в
 * `app.jsonl`, и в `session.jsonl`.
 */
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MODULES = join(ROOT, "src", "modules");
const SKIP = new Set(["node_modules", ".git"]);

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) files(join(dir, entry.name), out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) out.push(join(dir, entry.name));
  }
  return out;
}

describe("module logger binding", () => {
  it("не создаёт Logger на уровне модуля", () => {
    const offenders = files(MODULES)
      .filter((file) => /new Logger\s*\(/.test(readFileSync(file, "utf-8")))
      .map((file) => relative(ROOT, file));
    expect(offenders, "модуль обязан брать логгер из ModuleCtx/конструктора").toEqual([]);
  });
});
