// Хранилище артефактов сессии: запись/чтение файлов в <baseDir>/.mma/artifacts/<sessionId>.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

/** Опции хранилища артефактов: корень проекта, id сессии, относительный каталог. */
export interface ArtifactStoreOptions {
  baseDir: string;
  sessionId: string;
  /** Каталог относительно baseDir. По умолчанию: ".mma/artifacts". */
  artifactsDir?: string;
}

/** Файловое хранилище артефактов сессии (jail внутри root). */
export class ArtifactStore {
  private readonly root: string;

  constructor(opts: ArtifactStoreOptions) {
    const artifactsDir = opts.artifactsDir || ".mma/artifacts";
    this.root = resolve(opts.baseDir, artifactsDir, opts.sessionId);
  }

  /** Нормализует имя к [a-zA-Z0-9._-]; никогда не пустое, не "." и не "..". */
  static sanitizeName(name: string): string {
    // Срезаем префиксы обхода: "../../etc/passwd" станет "etc_passwd", а не ".._.._etc_passwd".
    const stripped = name.replace(/^(\.\.?[\\/])+/g, "").replace(/^\.{1,2}$/, "");
    const cleaned = stripped
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/_{2,}/g, "_")
      .replace(/^_+|_+$/g, "");
    if (cleaned === "" || cleaned === "." || cleaned === "..") {
      return "artifact";
    }
    return cleaned;
  }

  /** True, если `candidate` строго внутри `root` (или равен ему). */
  private static isInside(root: string, candidate: string): boolean {
    const rel = relative(root, candidate);
    if (rel === "") return true;
    return !rel.startsWith("..") && !isAbsolute(rel);
  }

  /**
   * Сохраняет контент в <root>/<name>.<ext>, возвращает абсолютный путь.
   * Бросает, если путь выходит за root (defense in depth — sanitizeName уже убрал разделители).
   */
  save(name: string, content: string, ext = "md"): string {
    const safe = ArtifactStore.sanitizeName(name);
    const dir = resolve(this.root);
    mkdirSync(dir, { recursive: true });
    const abs = resolve(dir, `${safe}.${ext}`);
    if (!ArtifactStore.isInside(dir, abs)) {
      throw new Error(`Artifact path escapes root: ${abs}`);
    }
    writeFileSync(abs, content, "utf8");
    return abs;
  }

  /** Читает артефакт по имени файла (относительно root); null, если вне root или нет файла. */
  read(path: string): string | null {
    const abs = resolve(this.root, path);
    if (!ArtifactStore.isInside(this.root, abs)) return null;
    if (!existsSync(abs)) return null;
    return readFileSync(abs, "utf8");
  }

  /** Первые maxChars символов (обрезанные справа) + маркер усечения. */
  summary(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    const head = content.slice(0, maxChars).trimEnd();
    return `${head}\n…[truncated: ${content.length - maxChars} chars]`;
  }
}
