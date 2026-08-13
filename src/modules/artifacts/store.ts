import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

export interface ArtifactStoreOptions {
  baseDir: string;
  sessionId: string;
  /** Directory relative to baseDir. Default: ".mma/artifacts". */
  artifactsDir?: string;
}

export class ArtifactStore {
  private readonly root: string;

  constructor(opts: ArtifactStoreOptions) {
    const artifactsDir = opts.artifactsDir || ".mma/artifacts";
    this.root = resolve(opts.baseDir, artifactsDir, opts.sessionId);
  }

  /** Normalize to [a-zA-Z0-9._-]; never empty, never "." or "..". */
  static sanitizeName(name: string): string {
    // Strip traversal prefixes so "../../etc/passwd" becomes "etc_passwd",
    // never ".._.._etc_passwd".
    const stripped = name
      .replace(/^(\.\.?[\\/])+/g, "")
      .replace(/^\.{1,2}$/, "");
    const cleaned = stripped
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/_{2,}/g, "_")
      .replace(/^_+|_+$/g, "");
    if (cleaned === "" || cleaned === "." || cleaned === "..") {
      return "artifact";
    }
    return cleaned;
  }

  /** True when `candidate` is strictly inside (or equal to) `root`. */
  private static isInside(root: string, candidate: string): boolean {
    const rel = relative(root, candidate);
    if (rel === "") return true;
    return !rel.startsWith("..") && !isAbsolute(rel);
  }

  /**
   * Persist content to <root>/<name>.<ext> and return the absolute path.
   * Throws if the resolved path escapes root (defense in depth — sanitizeName already removes separators).
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

  /** Read an artifact by its file name (relative to root); null when outside the root or missing. */
  read(path: string): string | null {
    const abs = resolve(this.root, path);
    if (!ArtifactStore.isInside(this.root, abs)) return null;
    if (!existsSync(abs)) return null;
    return readFileSync(abs, "utf8");
  }

  /** First maxChars chars (trimmed) + truncation marker. */
  summary(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    const head = content.slice(0, maxChars).trimEnd();
    return `${head}\n…[truncated: ${content.length - maxChars} chars]`;
  }
}
