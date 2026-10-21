// Загрузчик скиллов: рекурсивный скан .md-файлов с frontmatter-метаданными.
import { readdirSync, readFileSync, existsSync, statSync, type Stats } from "fs";
import { join } from "path";

/** Метаданные скилла: имя, описание, ключи поиска, тело и путь источника. */
export interface SkillMeta {
  name: string;
  description: string;
  keywords: string[];
  content: string;
  sourcePath: string;
}

/** Загрузчик скиллов из каталогов (встроенные, глобальные, проектные). */
export class SkillsLoader {
  /** Рекурсивно грузит все скиллы из каталога; нет каталога — пусто. */
  loadFromDir(dirPath: string): SkillMeta[] {
    if (!existsSync(dirPath)) return [];

    const skills: SkillMeta[] = [];
    this.scanDir(dirPath, skills);
    return skills;
  }

  private scanDir(dirPath: string, skills: SkillMeta[]): void {
    const entries = readdirSync(dirPath);

    for (const entry of entries) {
      const fullPath = join(dirPath, entry);
      let stat: Stats;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        this.scanDir(fullPath, skills);
        continue;
      }

      if (!entry.endsWith(".md") && !entry.endsWith(".skill.md")) continue;

      const content = readFileSync(fullPath, "utf-8");
      const parsed = this.parseSkillFile(content, fullPath);
      if (parsed) skills.push(parsed);
    }
  }

  private parseSkillFile(content: string, sourcePath: string): SkillMeta | null {
    // BOM режем: файл из Windows-редактора начинается с U+FEFF, и весь
    // фронтматтер не матчился — скилл молча не грузился.
    const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;

    const frontmatter = this.parseFrontmatter(match[1]);
    if (!frontmatter.name) return null;

    // Версия сравнивается численно: "2.1" не равно "2", но скилл рассчитан
    // на текущий формат.
    if (frontmatter.mma_version !== undefined) {
      const major = parseFloat(String(frontmatter.mma_version));
      if (!Number.isNaN(major) && major > 2) return null;
    }

    return {
      name: String(frontmatter.name).trim(),
      description: frontmatter.description || "",
      keywords: frontmatter.keywords || [],
      content: match[2].trim(),
      sourcePath,
    };
  }

  /**
   * Фронтматтер: `key: value`, списки `[a, b]` и YAML-блочные скаляры
   * (`description: >` / `|` / `>-`) с многострочным значением.
   */
  private parseFrontmatter(yaml: string): Record<string, any> {
    const result: Record<string, any> = {};
    const lines = yaml.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const kvMatch = lines[i].match(/^(\w+):\s*(.*)$/);
      if (!kvMatch) continue;
      const key = kvMatch[1];
      const raw = kvMatch[2].trim();

      // Блочный скаляр: значение — следующие строки с отступом.
      if (/^[>|][-+]?$/.test(raw)) {
        const block: string[] = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          if (!/^\s+\S/.test(lines[j])) break;
          block.push(lines[j].trim());
        }
        // «|» — литерал (переводы строк сохраняются), «>» — свёртка в пробелы.
        const joined = raw.startsWith("|") ? block.join("\n") : block.join(" ");
        result[key] = joined.trim();
        i = j - 1;
        continue;
      }

      if (raw.startsWith("[") && raw.endsWith("]")) {
        result[key] = raw
          .slice(1, -1)
          .split(",")
          .map((s: string) => s.trim().replace(/^['"]|['"]$/g, ""));
      } else {
        result[key] = raw.replace(/^['"]|['"]$/g, "");
      }
    }
    return result;
  }

  /**
   * Скиллы из трёх источников с дедупликацией по имени: проектный перекрывает
   * глобальный, глобальный — встроенный (аудит §2.8).
   */
  loadFromAllSources(builtinDir: string, globalDir: string, projectDir: string): SkillMeta[] {
    const byName = new Map<string, SkillMeta>();
    for (const skill of this.loadFromDir(builtinDir)) byName.set(skill.name, skill);
    for (const skill of this.loadFromDir(globalDir)) byName.set(skill.name, skill);
    for (const skill of this.loadFromDir(projectDir)) byName.set(skill.name, skill);
    return [...byName.values()];
  }
}
