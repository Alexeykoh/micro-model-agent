import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Гейд CHANGELOG: правки/releases пишутся в большой файл вручную, и два раза
 * уже проезжали повреждения — CP866-мусор вместо кириллицы и пустая секция
 * релиза после неудачного бампа. Проверка дешёвая и ловит их сразу.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const changelog = readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf8");
const lines = changelog.split(/\r?\n/);

describe("CHANGELOG health", () => {
  it("не содержит CP866-мусора вместо кириллицы", () => {
    // ╨Я = «П», ┬л = ««», тЦ▓ = «↑» — UTF8-байты, прочитанные как DOS-кодировка.
    const mojibake = /[╨╤╟┬]|тЦ|тАФ|тОЗ/g;
    expect(changelog.match(mojibake)).toBeNull();
  });

  it("не оставляет пустые секции релизов", () => {
    const empty: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^## \[(?!Unreleased)/.test(lines[i])) continue;
      let next = i + 1;
      while (next < lines.length && lines[next].trim() === "") next += 1;
      if (next < lines.length && /^## \[/.test(lines[next])) empty.push(lines[i]);
    }
    expect(empty).toEqual([]);
  });

  it("начинает историю релизов с версии из package.json", () => {
    const pkg: { version: string } = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
    );
    const unreleased = lines.findIndex((line) => /^## \[Unreleased\]\s*$/i.test(line));
    const firstRelease = lines.findIndex(
      (line, i) => i > unreleased && /^## \[\d+\.\d+\.\d+\]/.test(line),
    );
    expect(unreleased).toBeGreaterThanOrEqual(0);
    expect(firstRelease).toBeGreaterThan(unreleased);
    expect(lines[firstRelease]).toContain(`## [${pkg.version}]`);
  });
});
