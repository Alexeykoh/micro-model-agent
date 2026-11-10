// Загрузчик скиллов: рекурсивный скан .md-файлов с frontmatter-метаданными.
import { readdirSync, readFileSync, existsSync, statSync, type Stats } from "fs";
import { join } from "path";
import { createHash, verify as cryptoVerify } from "node:crypto";

/**
 * Подписанный манифест (P1 supply-chain): `skills-manifest.sig.json` —
 * `{manifestSha256, sig}` (Ed25519 по сырым байтам манифеста),
 * публичный ключ — `skills-manifest.pubkey` (PEM). Нет sig-файла — только
 * sha-проверка; есть sig, но неверен или нет ключа — fail-closed.
 */
export function skillManifestSignatureOk(dirPath: string): boolean {
  const sigPath = join(dirPath, "skills-manifest.sig.json");
  if (!existsSync(sigPath)) return true;
  const manifestPath = join(dirPath, "skills-manifest.json");
  const pubPath = join(dirPath, "skills-manifest.pubkey");
  if (!existsSync(manifestPath) || !existsSync(pubPath)) return false;
  try {
    const manifestRaw = readFileSync(manifestPath);
    const sig = JSON.parse(readFileSync(sigPath, "utf-8")) as { manifestSha256?: string; sig?: string };
    if (!sig.manifestSha256 || !sig.sig) return false;
    if (createHash("sha256").update(manifestRaw).digest("hex") !== sig.manifestSha256) return false;
    return cryptoVerify(null, manifestRaw, readFileSync(pubPath, "utf-8"), Buffer.from(sig.sig, "base64"));
  } catch {
    return false;
  }
}

/** Манифест целостности: имя файла → sha256 контента. */
export function skillManifestIntegrityOk(dirPath: string, fileName: string, content: string): boolean {
  const manifestPath = join(dirPath, "skills-manifest.json");
  if (!existsSync(manifestPath)) return true;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, string>;
    const expected = manifest[fileName];
    if (!expected) return false;
    const actual = createHash("sha256").update(content, "utf-8").digest("hex");
    return actual === expected;
  } catch {
    return false;
  }
}

/** Источник, из которого загружен скилл: `builtin` — из поставки, `global`/`project` — внешние. */
export type SkillKind = "builtin" | "global" | "project";

/** Метаданные скилла: имя, источник, описание, ключи поиска, тело и путь файла. */
export interface SkillMeta {
  name: string;
  kind: SkillKind;
  description: string;
  keywords: string[];
  content: string;
  sourcePath: string;
}

/** Загрузчик скиллов из каталогов (встроенные, глобальные, проектные). */
export class SkillsLoader {
  /** Рекурсивно грузит все скиллы из каталога; нет каталога — пусто. */
  loadFromDir(dirPath: string, kind: SkillKind = "global"): SkillMeta[] {
    if (!existsSync(dirPath)) return [];
    // Подпись манифеста: неверная подпись = каталог не грузится целиком.
    if (!skillManifestSignatureOk(dirPath)) return [];

    const skills: SkillMeta[] = [];
    this.scanDir(dirPath, skills, kind);
    return skills;
  }

  private scanDir(dirPath: string, skills: SkillMeta[], kind: SkillKind): void {
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
        this.scanDir(fullPath, skills, kind);
        continue;
      }

      if (!entry.endsWith(".md") && !entry.endsWith(".skill.md")) continue;

      const content = readFileSync(fullPath, "utf-8");
      // Целостность supply-chain: skills-manifest.json в каталоге обязан
      // совпасть с sha256 файла, иначе скилл не грузится (fail-closed).
      if (!skillManifestIntegrityOk(dirPath, entry, content)) continue;
      const parsed = this.parseSkillFile(content, fullPath, kind);
      if (parsed) skills.push(parsed);
    }
  }

  private parseSkillFile(content: string, sourcePath: string, kind: SkillKind): SkillMeta | null {
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
      kind,
      description: typeof frontmatter.description === "string" ? frontmatter.description : "",
      keywords: Array.isArray(frontmatter.keywords)
        ? frontmatter.keywords.map((k) => String(k))
        : [],
      content: match[2].trim(),
      sourcePath,
    };
  }

  /**
   * Фронтматтер: `key: value`, списки `[a, b]` и YAML-блочные скаляры
   * (`description: >` / `|` / `>-`) с многострочным значением.
   */
  private parseFrontmatter(yaml: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
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
    for (const skill of this.loadFromDir(builtinDir, "builtin")) byName.set(skill.name, skill);
    for (const skill of this.loadFromDir(globalDir, "global")) byName.set(skill.name, skill);
    for (const skill of this.loadFromDir(projectDir, "project")) byName.set(skill.name, skill);
    return [...byName.values()];
  }
}
