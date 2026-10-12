import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectFiles } from "../helpers/import-graph";

/**
 * Архитектурный гейт D (правило 6 «≤300 строк»): файл больше 300 строк обязан
 * быть в `.arch-allowlist.json` с текущим потолком. Потолки могут только
 * уменьшаться, а список — сокращаться: как только файл опускается до ≤300,
 * запись обязана быть удалена. Так долг виден и не «застывает».
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SRC_ROOT = join(REPO_ROOT, "src");
const ALLOWLIST = join(REPO_ROOT, ".arch-allowlist.json");
const LIMIT = 300;

interface Allowlist {
  files: Record<string, number>;
}

function lineCount(text: string): number {
  // Игнорируем один завершающий перевод строки — иначе файл ровно в 300 строк
  // посчитался бы как 301.
  return text.replace(/\n$/, "").split("\n").length;
}

describe("architecture: file size gate D (rule 6)", () => {
  it("every file >300 lines is allowlisted with a ceiling that only shrinks", () => {
    const allow = JSON.parse(readFileSync(ALLOWLIST, "utf-8")) as Allowlist;
    const files = collectFiles(SRC_ROOT, REPO_ROOT, [".ts", ".tsx"]);
    const offenders: string[] = [];

    for (const file of files) {
      const lines = lineCount(file.text);
      const ceiling = allow.files[file.path];
      if (ceiling === undefined) {
        if (lines > LIMIT) offenders.push(`${file.path}: ${lines} lines, not allowlisted`);
        continue;
      }
      if (lines > ceiling) {
        offenders.push(`${file.path}: ${lines} > ceiling ${ceiling} (may only shrink)`);
      } else if (lines <= LIMIT) {
        offenders.push(`${file.path}: ${lines} ≤ ${LIMIT}, remove the allowlist entry`);
      }
    }

    // Записи-сироты (файла нет) тоже ошибка: список не должен гнить.
    const known = new Set(files.map((f) => f.path));
    for (const path of Object.keys(allow.files)) {
      if (!known.has(path)) offenders.push(`${path}: allowlisted but does not exist`);
    }

    expect(
      offenders,
      `File-size rule 6 (≤300 lines). Split the file, or bump nothing — ` +
        `ceilings only shrink and the allowlist only shrinks:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
