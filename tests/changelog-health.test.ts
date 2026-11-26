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

  it("не повторяет подзаголовки внутри секции релиза", () => {
    const offenders: string[] = [];
    let section = "";
    const seen = new Set<string>();
    for (const line of lines) {
      if (/^## \[/.test(line)) {
        section = line;
        seen.clear();
        continue;
      }
      const match = /^### (.+?)\s*$/.exec(line);
      if (!match) continue;
      if (seen.has(match[1])) offenders.push(`${section}: ${match[1]}`);
      seen.add(match[1]);
    }
    expect(offenders).toEqual([]);
  });

  it("держит свежие релизы в порядке убывания версии", () => {
    const version = (title: string): number[] => {
      const match = /^## \[(\d+)\.(\d+)\.(\d+)\]/.exec(title);
      if (!match) throw new Error(`not a release heading: ${title}`);
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    };
    const recent = lines.filter((line) => /^## \[\d+\.\d+\.\d+\]/.test(line)).slice(0, 8);
    for (let i = 1; i < recent.length; i += 1) {
      const a = version(recent[i - 1]);
      const b = version(recent[i]);
      const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      expect(cmp).toBeGreaterThanOrEqual(0);
    }
  });
});
