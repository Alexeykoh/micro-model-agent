import { readdirSync, readFileSync, statSync, existsSync, watch, FSWatcher } from "fs";
import { join, relative, extname } from "path";

const LANGUAGES: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript-react",
  ".js": "javascript",
  ".jsx": "javascript-react",
  ".json": "json",
  ".md": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
};

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".mma", "coverage"]);

export interface IndexedFile {
  path: string;
  language: string;
  exports: string[];
  size: number;
}

export interface IndexResult {
  files: IndexedFile[];
  totalSize: number;
}

export class Indexer {
  private baseDir: string;
  private MAX_FILES = 1000;
  private watcher: FSWatcher | null = null;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  watch(callback: (event: string, filename: string | null) => void): void {
    this.watcher = watch(this.baseDir, { recursive: true }, (event, filename) => {
      if (filename && !Array.from(IGNORE_DIRS).some((dir) => filename.includes(dir))) {
        callback(event, filename);
      }
    });
  }

  unwatch(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  async walk(): Promise<IndexResult> {
    const files: IndexedFile[] = [];
    let totalSize = 0;
    let count = 0;

    const walkDir = (dir: string): void => {
      if (!existsSync(dir)) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (count >= this.MAX_FILES) return;
        const fullPath = join(dir, entry);
        const relPath = relative(this.baseDir, fullPath);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          if (!IGNORE_DIRS.has(entry)) {
            walkDir(fullPath);
          }
        } else if (stat.isFile()) {
          const ext = extname(entry).toLowerCase();
          const language = LANGUAGES[ext];
          if (language) {
            const content = readFileSync(fullPath, "utf-8");
            const exports = this.extractExports(content, language);
            files.push({ path: relPath, language, exports, size: stat.size });
            totalSize += stat.size;
            count++;
          }
        }
      }
    };

    walkDir(this.baseDir);
    return { files, totalSize };
  }

  private extractExports(content: string, language: string): string[] {
    if (language === "typescript" || language === "javascript") {
      const exports: string[] = [];
      const exportRegex =
        /export\s+(?:const|function|class|interface|type|enum|default\s+(?:class|function))\s+(\w+)/g;
      let match: RegExpExecArray | null;
      while ((match = exportRegex.exec(content)) !== null) {
        exports.push(match[1]);
      }
      return exports;
    }
    return [];
  }

  summarize(result: IndexResult): string {
    const byLang: Record<string, number> = {};
    for (const f of result.files) {
      byLang[f.language] = (byLang[f.language] || 0) + 1;
    }
    const langs = Object.entries(byLang)
      .sort((a, b) => b[1] - a[1])
      .map(([lang, count]) => `${lang}:${count}`)
      .join(", ");

    return `[Index: ${result.files.length} files, ${(result.totalSize / 1024).toFixed(1)}KB (${langs})]`;
  }
}
