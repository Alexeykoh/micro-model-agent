// `web-build:`-проверка шага плана: собранный артефакт, а не «build прошёл».
//
// Формат: `web-build:<dir>` — каталог сборки относительно baseDir. Проверка
// отвечает на два вопроса, которые `command: npm run build` пропускает:
// 1) CSS собран и содержит Tailwind-утилиты (`--tw-*` или пары `.grid{`,
//    `.flex{`, `.hidden{`, `.block{`), а не пустой/несгенерированный файл;
// 2) index.html существует и не пуст: есть текст либо корневой узел SPA
//    (`id="root"|"app"|"__next"`) / `<canvas>`.
//
// Это осознанно статическая проверка артефакта (без запуска браузера): она
// ловит «сборка зелёная, страница без стилей/пустая» за миллисекунды. Runtime
// по-прежнему доказывается `browser:`/`http:`/тестами.
import { readdirSync, readFileSync, type Dirent } from "fs";
import { join, relative, resolve, sep } from "path";
import { resolveCheckPath } from "./check-path";

/** Потолок чтения одного CSS: больше не нужно для поиска утилит. */
export const WEB_BUILD_CSS_CAP_BYTES = 2 * 1024 * 1024;
/** Глубина обхода от каждого корня-кандидата (каталоги, не файлы). */
const MAX_DEPTH = 4;
/** Каталоги, в которые обход не заходит: тонны файлов и не артефакт сборки. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);
/** Типовые выходные каталоги: `dir` может быть корнем проекта, а не сборкой. */
const COMMON_BUILD_SUBDIRS = ["dist", "build", "out", ".next/static/css"];
/** Минимум видимого текста, при котором страница не считается пустой. */
const MIN_TEXT_CHARS = 20;

const UTILITY_PATTERNS: RegExp[] = [
  /\.grid\s*\{/,
  /\.flex\s*\{/,
  /\.hidden\s*\{/,
  /\.block\s*\{/,
];

export interface WebBuildCheckResult {
  ok: boolean;
  /** Причина отказа (для сообщения модели); на успехе отсутствует. */
  reason?: string;
  /** Найденные CSS относительно baseDir (POSIX-разделители). */
  cssFiles: string[];
}

/** Обход каталога: файлы, чьё имя/расширение подходит, до `MAX_DEPTH`. */
function collectFiles(
  root: string,
  matches: (name: string) => boolean,
  out: string[],
): void {
  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
      } else if (entry.isFile() && matches(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
}

/** Каталоги-кандидаты: сам `dir` и типовые подкаталоги сборки; без дублей. */
function candidateRoots(dir: string): string[] {
  const roots = [dir, ...COMMON_BUILD_SUBDIRS.map((sub) => join(dir, ...sub.split("/")))];
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = resolve(root);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** CSS-файлы под `dir` и типовыми каталогами сборки. */
function findCssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const root of candidateRoots(dir)) collectFiles(root, (n) => /\.css$/i.test(n), out);
  return [...new Set(out)];
}

/** `index.html` под `dir` или типовыми каталогами сборки. */
function findIndexHtml(dir: string): string | null {
  for (const root of candidateRoots(dir)) {
    const found: string[] = [];
    collectFiles(root, (n) => n.toLowerCase() === "index.html", found);
    if (found.length > 0) return found[0];
  }
  return null;
}

/** Читает не больше `WEB_BUILD_CSS_CAP_BYTES` на файл; ошибки чтения — пусто. */
function readCss(file: string): string {
  try {
    return readFileSync(file, "utf8").slice(0, WEB_BUILD_CSS_CAP_BYTES);
  } catch {
    return "";
  }
}

/** Есть ли в CSS признаки сгенерированных Tailwind-утилит. */
function hasUtilityEvidence(css: string): boolean {
  if (css.includes("--tw-")) return true;
  return UTILITY_PATTERNS.filter((re) => re.test(css)).length >= 2;
}

/** Видимый текст: без script/style/комментариев/тегов и HTML-сущностей. */
function visibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Маркеры SPA/графики: страница без текста, но с корневым узлом — не пустая. */
function hasRootMarker(html: string): boolean {
  return (
    /id\s*=\s*(?:"(?:root|app|__next)"|'(?:root|app|__next)'|(?:root|app|__next)(?=[\s>]))/i.test(
      html,
    ) || /<canvas\b/i.test(html)
  );
}

/** Позитивный путь для отображения в логе/тесте. */
function toDisplayPath(baseDir: string, file: string): string {
  return relative(baseDir, file).split(sep).join("/");
}

/**
 * Проверяет артефакт веб-сборки. Не бросает: любая неудача — `ok:false` с
 * причиной (INV-G4). `dir` резолвится внутри `baseDir` тем же path-validator,
 * что и тулы (jail + symlink containment); выход за baseDir — отказ.
 */
export function checkWebBuild(baseDir: string, dir: string): WebBuildCheckResult {
  const resolution = resolveCheckPath(baseDir, dir, undefined, {
    enabled: true,
    denied: [],
    allowed: [],
  });
  if (resolution.blocked) {
    return { ok: false, reason: resolution.blocked, cssFiles: [] };
  }
  const root = resolve(baseDir, resolution.path);

  const cssFiles = findCssFiles(root);
  if (cssFiles.length === 0) {
    return { ok: false, reason: "no built CSS found", cssFiles: [] };
  }
  const css = cssFiles.map(readCss).join("\n");
  if (!hasUtilityEvidence(css)) {
    return {
      ok: false,
      reason: "CSS has no utility classes (Tailwind not generated?)",
      cssFiles: cssFiles.map((f) => toDisplayPath(baseDir, f)),
    };
  }

  const htmlPath = findIndexHtml(root);
  if (!htmlPath) {
    return {
      ok: false,
      reason: "no index.html in build output",
      cssFiles: cssFiles.map((f) => toDisplayPath(baseDir, f)),
    };
  }
  let html = "";
  try {
    html = readFileSync(htmlPath, "utf8");
  } catch {
    html = "";
  }
  if (visibleText(html).length < MIN_TEXT_CHARS && !hasRootMarker(html)) {
    return {
      ok: false,
      reason: "page is empty",
      cssFiles: cssFiles.map((f) => toDisplayPath(baseDir, f)),
    };
  }

  return { ok: true, cssFiles: cssFiles.map((f) => toDisplayPath(baseDir, f)) };
}
