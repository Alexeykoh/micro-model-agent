// Чтение CHANGELOG.md из установленного пакета и вырезка секций версий.
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";

/**
 * Читает bundled CHANGELOG.md из установленного npm-пакета.
 * Резолвится от местоположения этого файла (dist/modules/updater/) вверх
 * до корня пакета.
 */
export function readChangelog(packageName: string): string | null {
  try {
    // Идём вверх от этого файла в поисках package.json
    let dir = dirname(import.meta.url);
    // file:// URL в путь на POSIX, иначе используем путь как есть
    if (dir.startsWith("file://")) {
      dir = decodeURIComponent(dir.slice(7));
    }
    // Ищем корень пакета (package.json с совпадающим именем)
    for (let i = 0; i < 10; i++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name === packageName) {
          const changelogPath = join(dir, "CHANGELOG.md");
          if (existsSync(changelogPath)) {
            return readFileSync(changelogPath, "utf-8");
          }
          return null;
        }
      }
      dir = dirname(dir);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Вырезает записи между версиями (старая эксклюзивно, новая инклюзивно).
 * Возвращает сырые markdown-секции.
 *
 * parseChangelog(changelog, "0.55.1", "0.56.1") =>
 *   "## [0.56.1] - ...\n...\n## [0.56.0] - ...\n..."
 */
export function extractChangelogRange(
  changelog: string,
  fromVersion: string,
  _toVersion: string,
): string | null {
  const lines = changelog.split("\n");
  const sections: string[] = [];
  let capturing = false;
  let foundFrom = false;

  for (const line of lines) {
    const match = line.match(/^## \[(\d+\.\d+\.\d+)\]/);
    if (match) {
      const ver = match[1];
      if (ver === fromVersion) {
        // Стоп перед этой секцией (эксклюзивно).
        foundFrom = true;
        break;
      }
      if (capturing) {
        // Новый заголовок секции — отделяем пустой строкой.
        sections.push("");
      }
      capturing = true;
    }
    if (capturing) {
      sections.push(line);
    }
  }

  // Версия "from" так и не нашлась — валидного диапазона нет, возвращаем null.
  if (!foundFrom) return null;
  return sections.length > 0 ? sections.join("\n").trim() : null;
}

/** Берёт свежайшую запись changelog (самая верхняя версия). */
export function extractLatestChangelog(changelog: string): string | null {
  const lines = changelog.split("\n");
  const sections: string[] = [];
  let capturing = false;
  let found = false;

  for (const line of lines) {
    const match = line.match(/^## \[(\d+\.\d+\.\d+)\]/);
    if (match) {
      if (found) break; // Стоп на втором заголовке секции.
      capturing = true;
      found = true;
    }
    if (capturing) {
      sections.push(line);
    }
  }

  return sections.length > 0 ? sections.join("\n").trim() : null;
}
