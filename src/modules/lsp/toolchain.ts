// Детект версий тулчейнов проекта по стандартным манифестам — для всех языков,
// а не только JS. Зачем: `lsp doctor` советовал глобальную установку
// «последней» версии сервера (`typescript@5`, `@latest`) независимо от того,
// что проект реально собирается на старом рантайме (кейс: Angular 11 на Node 16,
// а подсказка — под Node 20+). Здесь версии только читаются с диска, без запуска
// инструментов: это дёшево и безопасно (bounded, без процессов).
import { existsSync, readFileSync } from "fs";
import { join } from "path";

/** Объявленная версия рантайма проекта (node/python/rust/go/…). */
export interface RuntimeVersion {
  /** Имя рантайма: `node`, `python`, `rust`, `go`, `ruby`, `php`, `dotnet`, … */
  name: string;
  /** Версия как объявлена (напр. `16.13.0`, `3.11`, `stable`). */
  version: string;
  /** Файл-источник версии (для показа в UI). */
  source: string;
}

/** Тулчейн проекта: рантаймы + объявленные версии пакетов. */
export interface ProjectToolchain {
  runtimes: RuntimeVersion[];
  /** Объявленные версии пакетов (`typescript` → `4.1.6`). */
  packages: Record<string, string>;
}

const EMPTY: ProjectToolchain = { runtimes: [], packages: {} };

/** Читает файл рядом с `baseDir`; отсутствие/ошибка — null. */
function readOrNull(baseDir: string, name: string): string | null {
  try {
    const p = join(baseDir, name);
    return existsSync(p) ? readFileSync(p, "utf-8") : null;
  } catch {
    return null;
  }
}

/** Первая версия из строки/диапазона: `^4.1.6` → `4.1.6`, `>=16` → `16`. */
function firstVersion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/\d+(?:\.\d+)?(?:\.\d+)?/);
  return m ? m[0] : (raw.trim() || null);
}

/** Плоское значение `engines.node`/`deps[name]` из распарсенного package.json. */
function pkgVersion(pkg: Record<string, unknown>, name: string): string | null {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = pkg[field];
    if (deps && typeof deps === "object" && !Array.isArray(deps)) {
      const v = (deps as Record<string, unknown>)[name];
      if (typeof v === "string" && v && !v.startsWith("file:") && !v.startsWith("workspace:")) return v;
    }
  }
  return null;
}

/** Безопасный `JSON.parse`; невалидный файл — null. */
function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Детект Node/TS/Angular-тулчейна (единственная «JS-ветка», не единственная). */
function detectNode(baseDir: string, out: ProjectToolchain): void {
  const fromFile = readOrNull(baseDir, ".nvmrc") ?? readOrNull(baseDir, ".node-version");
  const json = parseJson(readOrNull(baseDir, "package.json"));
  const engines = json && typeof json.engines === "object" ? (json.engines as Record<string, unknown>) : null;
  const node = firstVersion(fromFile) ?? firstVersion(engines?.node);
  const source = readOrNull(baseDir, ".nvmrc") !== null ? ".nvmrc"
    : readOrNull(baseDir, ".node-version") !== null ? ".node-version"
    : json ? "package.json#engines.node" : "";
  if (node && source) out.runtimes.push({ name: "node", version: node, source });
  const npm = firstVersion(engines?.npm);
  if (npm) out.runtimes.push({ name: "npm", version: npm, source: "package.json#engines.npm" });
  if (!json) return;
  for (const name of ["typescript", "@angular/core", "@angular/language-server", "@angular/cli"]) {
    const v = firstVersion(pkgVersion(json, name));
    if (v) out.packages[name] = v;
  }
}

/** Детект Python: `.python-version`, `runtime.txt`, `pyproject.toml` requires-python. */
function detectPython(baseDir: string, out: ProjectToolchain): void {
  const file = readOrNull(baseDir, ".python-version") ?? readOrNull(baseDir, "runtime.txt");
  if (file) {
    const v = firstVersion(file.replace(/^python-/i, ""));
    if (v) out.runtimes.push({ name: "python", version: v, source: readOrNull(baseDir, ".python-version") ? ".python-version" : "runtime.txt" });
    return;
  }
  const pyproject = readOrNull(baseDir, "pyproject.toml");
  if (pyproject) {
    const m = pyproject.match(/requires-python\s*=\s*["']([^"']+)["']/i);
    const v = firstVersion(m?.[1]);
    if (v) out.runtimes.push({ name: "python", version: v, source: "pyproject.toml" });
  }
}

/** Детект Rust: `rust-toolchain` / `rust-toolchain.toml` (channel). */
function detectRust(baseDir: string, out: ProjectToolchain): void {
  const plain = readOrNull(baseDir, "rust-toolchain");
  const toml = readOrNull(baseDir, "rust-toolchain.toml");
  if (plain) {
    const v = plain.trim().split(/\s+/)[0];
    if (v) out.runtimes.push({ name: "rust", version: v, source: "rust-toolchain" });
    return;
  }
  if (toml) {
    const m = toml.match(/channel\s*=\s*["']([^"']+)["']/i);
    const v = m?.[1]?.trim();
    if (v) out.runtimes.push({ name: "rust", version: v, source: "rust-toolchain.toml" });
  }
}

/** Детект Go: директива `go 1.x` в go.mod. */
function detectGo(baseDir: string, out: ProjectToolchain): void {
  const gomod = readOrNull(baseDir, "go.mod");
  if (!gomod) return;
  const m = gomod.match(/^\s*go\s+(\d+(?:\.\d+)?)/m);
  if (m) out.runtimes.push({ name: "go", version: m[1], source: "go.mod" });
}

/** Детект Ruby / PHP / .NET / Java по их стандартным маркерам. */
function detectOthers(baseDir: string, out: ProjectToolchain): void {
  const ruby = readOrNull(baseDir, ".ruby-version");
  if (ruby) {
    const v = firstVersion(ruby);
    if (v) out.runtimes.push({ name: "ruby", version: v, source: ".ruby-version" });
  }
  const java = readOrNull(baseDir, ".java-version");
  if (java) {
    const v = firstVersion(java);
    if (v) out.runtimes.push({ name: "java", version: v, source: ".java-version" });
  }
  const composer = parseJson(readOrNull(baseDir, "composer.json"));
  const require = composer && typeof composer.require === "object" ? (composer.require as Record<string, unknown>) : null;
  const php = firstVersion(require?.php);
  if (php) out.runtimes.push({ name: "php", version: php, source: "composer.json" });
  const global = parseJson(readOrNull(baseDir, "global.json"));
  const sdk = global && typeof global.sdk === "object" ? (global.sdk as Record<string, unknown>) : null;
  const dotnet = firstVersion(sdk?.version);
  if (dotnet) out.runtimes.push({ name: "dotnet", version: dotnet, source: "global.json" });
}

/**
 * Прочитать объявленные версии тулчейна из `baseDir`. Отсутствие любого маркера
 * — не ошибка: возвращается то, что нашлось (возможно, пусто).
 */
export function detectProjectToolchain(baseDir: string): ProjectToolchain {
  if (!baseDir) return { ...EMPTY, packages: {} };
  const out: ProjectToolchain = { runtimes: [], packages: {} };
  try {
    detectNode(baseDir, out);
    detectPython(baseDir, out);
    detectRust(baseDir, out);
    detectGo(baseDir, out);
    detectOthers(baseDir, out);
  } catch {
    /* fail-open: версии — вспомогательная информация, не повод падать */
  }
  return out;
}
