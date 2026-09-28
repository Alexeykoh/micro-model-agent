// Поиск по файлам памяти: подстрока без учёта регистра по .md и preferences.json.
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const MEMORY_FILES = ["conventions", "decisions", "errors", "facts"];

/** Одно совпадение: файл-источник и строка. */
export interface SearchResult {
  file: string;
  match: string;
}

/** Поисковик по каталогу памяти (создаётся под запрос, состояния нет). */
export class MemorySearch {
  private memoryDir: string;

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir;
  }

  /** Ищет подстроку (без учёта регистра) по .md-файлам и преференсам. */
  query(query: string): SearchResult[] {
    const results: SearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    for (const name of MEMORY_FILES) {
      const path = join(this.memoryDir, `${name}.md`);
      if (!existsSync(path)) continue;

      const content = readFileSync(path, "utf-8");
      const lines = content.split("\n");

      for (const line of lines) {
        if (line.toLowerCase().includes(lowerQuery)) {
          results.push({ file: name, match: line.trim() });
        }
      }
    }

    // Поиск по preferences.json
    const prefsPath = join(this.memoryDir, "preferences.json");
    if (existsSync(prefsPath)) {
      try {
        const prefs: Record<string, string> = JSON.parse(readFileSync(prefsPath, "utf-8"));
        for (const [key, value] of Object.entries(prefs)) {
          const searchStr = `${key}=${value}`;
          if (searchStr.toLowerCase().includes(lowerQuery)) {
            results.push({ file: "preferences", match: `${key} = ${value}` });
          }
        }
      } catch {
        /* skip */
      }
    }

    return results;
  }
}
