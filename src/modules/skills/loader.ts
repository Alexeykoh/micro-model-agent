import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

export interface SkillMeta {
  name: string;
  description: string;
  keywords: string[];
  content: string;
  sourcePath: string;
}

export class SkillsLoader {
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
      const stat = statSync(fullPath);

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
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;

    const frontmatter = this.parseFrontmatter(match[1]);
    if (!frontmatter.name) return null;

    if (frontmatter.mma_version && String(frontmatter.mma_version) !== "2") {
      return null;
    }

    return {
      name: frontmatter.name,
      description: frontmatter.description || "",
      keywords: frontmatter.keywords || [],
      content: match[2].trim(),
      sourcePath,
    };
  }

  private parseFrontmatter(yaml: string): Record<string, any> {
    const result: Record<string, any> = {};
    for (const line of yaml.split("\n")) {
      const kvMatch = line.match(/^(\w+):\s*(.+)$/);
      if (kvMatch) {
        const val = kvMatch[2].trim();
        if (val.startsWith("[") && val.endsWith("]")) {
          result[kvMatch[1]] = val
            .slice(1, -1)
            .split(",")
            .map((s: string) => s.trim().replace(/^['"]|['"]$/g, ""));
        } else {
          result[kvMatch[1]] = val.replace(/^['"]|['"]$/g, "");
        }
      }
    }
    return result;
  }

  loadFromAllSources(builtinDir: string, globalDir: string, projectDir: string): SkillMeta[] {
    return [
      ...this.loadFromDir(builtinDir),
      ...this.loadFromDir(globalDir),
      ...this.loadFromDir(projectDir),
    ];
  }
}
