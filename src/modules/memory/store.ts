import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { MemorySearch } from "./search";

const MEMORY_FILES = ["conventions", "decisions", "errors", "facts"];

export class MemoryStore {
  private memoryDir: string;

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir;
    this.ensureDir();
    for (const name of MEMORY_FILES) {
      const path = join(this.memoryDir, `${name}.md`);
      if (!existsSync(path)) {
        writeFileSync(path, `# ${name.charAt(0).toUpperCase() + name.slice(1)}\n\n`, "utf-8");
      }
    }
  }

  private ensureDir(): void {
    if (!existsSync(this.memoryDir)) {
      mkdirSync(this.memoryDir, { recursive: true });
    }
  }

  read(name: string): string {
    const path = join(this.memoryDir, `${name}.md`);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  }

  append(name: string, entry: string): void {
    const path = join(this.memoryDir, `${name}.md`);
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const formatted = `- **${timestamp}** — ${entry}\n`;
    appendFileSync(path, formatted, "utf-8");
  }

  search(query: string): Array<{ file: string; match: string }> {
    const searchModule = new MemorySearch(this.memoryDir);
    return searchModule.query(query);
  }

  private prefsPath(): string {
    return join(this.memoryDir, "preferences.json");
  }

  getPreferences(): Record<string, string> {
    const path = this.prefsPath();
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return {};
    }
  }

  setPreference(key: string, value: string): void {
    const prefs = this.getPreferences();
    prefs[key] = value;
    writeFileSync(this.prefsPath(), JSON.stringify(prefs, null, 2), "utf-8");
  }

  deletePreference(key: string): boolean {
    const prefs = this.getPreferences();
    if (!(key in prefs)) return false;
    delete prefs[key];
    writeFileSync(this.prefsPath(), JSON.stringify(prefs, null, 2), "utf-8");
    return true;
  }

  /** Remove the nth (1-based) append-only entry from a category file. */
  deleteEntry(name: string, n: number): boolean {
    const path = join(this.memoryDir, `${name}.md`);
    if (!existsSync(path)) return false;
    const lines = readFileSync(path, "utf-8").split(/\r?\n/);
    const indexes = lines
      .map((l, i) => (l.startsWith("- ") ? i : -1))
      .filter((i) => i >= 0);
    if (n < 1 || n > indexes.length) return false;
    lines.splice(indexes[n - 1], 1);
    writeFileSync(path, lines.join("\n"), "utf-8");
    return true;
  }

  appendRule(category: string, pattern: string, cause: string, solution: string): void {
    const entry = `**pattern:** ${pattern}\n  **cause:** ${cause}\n  **solution:** ${solution}`;
    this.append(category, entry);
  }
}
