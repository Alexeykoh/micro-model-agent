import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Гейт документации: каждая относительная ссылка в Markdown должна вести на
 * существующий файл или каталог. Спеки и планы переезжают в `docs/archive/`,
 * и без этой проверки битые ссылки переживают перенос незамеченными.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SKIP_DIRS = new Set([
  ".git",
  ".fallow",
  ".mma",
  ".opencode",
  ".playwright-mcp",
  "dist",
  "gh-pages",
  "node_modules",
  "release",
  "tmp",
]);

function collectMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collectMarkdown(join(dir, entry.name)));
      continue;
    }
    if (entry.name.endsWith(".md")) out.push(join(dir, entry.name));
  }
  return out;
}

/** Прячет код, чтобы `enum[a,b](true)` не считался ссылкой. */
function maskCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function checkFile(file: string, errors: string[]): void {
  const text = maskCode(readFileSync(file, "utf8"));
  const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");

  const targets: string[] = [];
  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    targets.push(m[1]);
  }
  for (const m of text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)\s*$/gm)) {
    targets.push(m[1]);
  }

  for (const raw of targets) {
    if (/^(https?:|mailto:|data:|tel:|#)/i.test(raw)) continue;
    let target = raw.replace(/^<|>$/g, "");
    const hash = target.indexOf("#");
    if (hash >= 0) target = target.slice(0, hash);
    if (!target) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      // оставляем как есть — если и так не найдётся, тест покажет путь
    }
    const candidates = [join(dirname(file), target), join(REPO_ROOT, target.replace(/^\.\//, ""))];
    if (!candidates.some(exists)) errors.push(`${rel}: ${raw}`);
  }

  // Текстовые (не markdown) пути к спекам и планам тоже не должны протухать.
  for (const m of text.matchAll(/docs\/(?:specs|plans)\/[A-Za-z0-9._/-]+\.md/g)) {
    if (!exists(join(REPO_ROOT, m[0]))) errors.push(`${rel}: ${m[0]}`);
  }
}

describe("docs: markdown links resolve", () => {
  it("has no broken relative links or stale spec/plan paths", () => {
    const errors: string[] = [];
    for (const file of collectMarkdown(REPO_ROOT)) checkFile(file, errors);
    expect(errors).toEqual([]);
  });
});
