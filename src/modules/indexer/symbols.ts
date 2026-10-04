/**
 * Реестр языков и извлечение символов для индекса проекта.
 *
 * Новый язык = одна запись в `RULES` + одно или больше расширений в
 * `EXT_TO_LANGUAGE`. Каждое правило объявляет, код ли это (для ранжирования
 * карты) и как тянуть публичные/экспортные имена из файла. Извлечение
 * regex-based осознанно (без зависимости от парсера): дёшево, гоняется на
 * каждом индексируемом файле, и структуры хватает для полезности карты —
 * полный AST не нужен.
 *
 * Помимо имени символ несёт номер строки и `kind` (`function`/`class`/…) —
 * этого достаточно для `outline` и `find_symbol` без чтения файла.
 */

/** Кап на файл: один генерированный файл не раздувает карту. */
export const MAX_SYMBOLS_PER_FILE = 40;

/** Один извлечённый символ: имя, 1-based строка, категория. */
export interface SymbolLocation {
  name: string;
  line: number;
  kind: string;
}

/** Регексп + метаданные для одной группы определений. */
interface Pattern {
  re: RegExp;
  /** Статический kind, если он не берётся из группы. */
  kind?: string;
  /** Номер группы с kind (перекрывает статический). */
  kindGroup?: number;
  /** Номер группы с именем (по умолчанию 1). */
  nameGroup?: number;
}

interface LanguageRule {
  /** True для языков программирования — ранжирует файлы в карте. */
  code: boolean;
  extract: (content: string) => SymbolLocation[];
}

/** Уникальные имена с сохранением порядка (первое вхождение выигрывает). */
function dedupe(symbols: SymbolLocation[]): SymbolLocation[] {
  const seen = new Set<string>();
  const out: SymbolLocation[] = [];
  for (const sym of symbols) {
    if (sym.name && !seen.has(sym.name)) {
      seen.add(sym.name);
      out.push(sym);
    }
  }
  return out;
}

/** 1-based номер строки для индекса символа в содержимом. */
function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** Собирает символы по списку глобальных (многострочных) regex'ов. */
function collect(content: string, patterns: Pattern[]): SymbolLocation[] {
  const symbols: SymbolLocation[] = [];
  for (const pattern of patterns) {
    const { re, kind, kindGroup, nameGroup = 1 } = pattern;
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const name = match[nameGroup];
      if (name) {
        const resolvedKind = kindGroup !== undefined ? (match[kindGroup] ?? kind ?? "") : (kind ?? "");
        symbols.push({ name, line: lineAt(content, match.index), kind: resolvedKind });
      }
      if (match.index === re.lastIndex) re.lastIndex++;
    }
  }
  return symbols;
}

/** Символы из клауз `export { a, b as c }` / `export type { X }`. */
function collectExportClauses(content: string): SymbolLocation[] {
  const symbols: SymbolLocation[] = [];
  const re = /export\s+(?:type\s+)?\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    for (const part of match[1].split(",")) {
      const cleaned = part.trim().replace(/^type\s+/, "");
      if (!cleaned || cleaned.startsWith("//")) continue;
      const alias = cleaned.split(/\s+as\s+/);
      const exported = (alias.length > 1 ? alias[1] : alias[0]).trim();
      if (/^\w+$/.test(exported)) {
        symbols.push({ name: exported, line: lineAt(content, match.index), kind: "export" });
      }
    }
  }
  return symbols;
}

const TS_JS_PATTERNS: Pattern[] = [
  {
    re: /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(const|let|var|function|class|interface|type|enum)\s+(\w+)/gm,
    kindGroup: 1,
    nameGroup: 2,
  },
  {
    re: /^export\s+default\s+(class|function)\s+(\w+)/gm,
    kindGroup: 1,
    nameGroup: 2,
  },
];

function tsLike(content: string): SymbolLocation[] {
  return dedupe([...collect(content, TS_JS_PATTERNS), ...collectExportClauses(content)]);
}

const PYTHON_PATTERNS: Pattern[] = [
  { re: /^(?:async\s+)?def\s+(\w+)/gm, kind: "function" },
  { re: /^class\s+(\w+)/gm, kind: "class" },
];

const RUST_PATTERNS: Pattern[] = [
  {
    re: /^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|const|static|type|mod)\s+(\w+)/gm,
    kind: "item",
  },
  { re: /macro_rules!\s+(\w+)/g, kind: "macro" },
];

const GO_PATTERNS: Pattern[] = [
  { re: /^func\s+(\w+)\s*[([]/gm, kind: "function" },
  { re: /^func\s+\([^)]*\)\s+(\w+)\s*[([]/gm, kind: "method" },
  { re: /^type\s+(\w+)/gm, kind: "type" },
  { re: /^(?:var|const)\s+(\w+)/gm, kind: "var" },
];

const JAVA_PATTERNS: Pattern[] = [
  {
    re: /^\s*(?:(?:public|protected|private|final|abstract|static|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record)\s+(\w+)/gm,
    kind: "type",
  },
];

const KOTLIN_PATTERNS: Pattern[] = [
  {
    re: /^\s*(?:(?:public|internal|private|protected|open|abstract|sealed|data|enum|annotation|value|inline)\s+)*(?:class|interface|object)\s+(\w+)/gm,
    kind: "type",
  },
  {
    re: /^\s*(?:(?:public|internal|private|protected|open|override|suspend|inline|operator|infix|tailrec|external)\s+)*fun\s+(\w+)/gm,
    kind: "function",
  },
];

const CSHARP_PATTERNS: Pattern[] = [
  {
    re: /^\s*(?:(?:public|internal|private|protected|static|sealed|abstract|partial|readonly|unsafe|new|record)\s+)*(?:class|interface|struct|enum|record)\s+(\w+)/gm,
    kind: "type",
  },
];

const RUBY_PATTERNS: Pattern[] = [
  { re: /^\s*(?:def|class|module)\s+([A-Za-z_]\w*[?!]?)/gm, kind: "member" },
];

const PHP_PATTERNS: Pattern[] = [
  { re: /\b(?:function|class|interface|trait|enum)\s+(\w+)/g, kind: "member" },
];

const SWIFT_PATTERNS: Pattern[] = [
  { re: /\b(?:func|class|struct|enum|protocol|extension)\s+(\w+)/g, kind: "member" },
];

const SCALA_PATTERNS: Pattern[] = [
  {
    re: /^\s*(?:(?:private|protected|final|abstract|sealed|implicit|lazy|override)\s+)*(?:def|class|object|trait)\s+(\w+)/gm,
    kind: "member",
  },
];

const C_CPP_PATTERNS: Pattern[] = [
  { re: /^\s*(?:typedef\s+)?(?:class|struct|enum|union|namespace)\s+(\w+)/gm, kind: "type" },
  { re: /\}\s*(\w+)\s*;/g, kind: "type" },
];

const SHELL_PATTERNS: Pattern[] = [
  { re: /^\s*(?:function\s+)?(\w+)\s*\(\s*\)\s*\{/gm, kind: "function" },
];

const LUA_PATTERNS: Pattern[] = [
  { re: /^\s*(?:local\s+)?function\s+([\w.:]+)/gm, kind: "function" },
];

const NO_SYMBOLS = (): SymbolLocation[] => [];

const RULES: Record<string, LanguageRule> = {
  typescript: { code: true, extract: tsLike },
  "typescript-react": { code: true, extract: tsLike },
  javascript: { code: true, extract: tsLike },
  "javascript-react": { code: true, extract: tsLike },
  python: { code: true, extract: (c) => collect(c, PYTHON_PATTERNS) },
  rust: { code: true, extract: (c) => collect(c, RUST_PATTERNS) },
  go: { code: true, extract: (c) => collect(c, GO_PATTERNS) },
  java: { code: true, extract: (c) => collect(c, JAVA_PATTERNS) },
  kotlin: { code: true, extract: (c) => collect(c, KOTLIN_PATTERNS) },
  csharp: { code: true, extract: (c) => collect(c, CSHARP_PATTERNS) },
  ruby: { code: true, extract: (c) => collect(c, RUBY_PATTERNS) },
  php: { code: true, extract: (c) => collect(c, PHP_PATTERNS) },
  swift: { code: true, extract: (c) => collect(c, SWIFT_PATTERNS) },
  scala: { code: true, extract: (c) => collect(c, SCALA_PATTERNS) },
  c: { code: true, extract: (c) => collect(c, C_CPP_PATTERNS) },
  cpp: { code: true, extract: (c) => collect(c, C_CPP_PATTERNS) },
  shell: { code: true, extract: (c) => collect(c, SHELL_PATTERNS) },
  lua: { code: true, extract: (c) => collect(c, LUA_PATTERNS) },
  json: { code: false, extract: NO_SYMBOLS },
  markdown: { code: false, extract: NO_SYMBOLS },
  yaml: { code: false, extract: NO_SYMBOLS },
  toml: { code: false, extract: NO_SYMBOLS },
  xml: { code: false, extract: NO_SYMBOLS },
  html: { code: false, extract: NO_SYMBOLS },
  css: { code: false, extract: NO_SYMBOLS },
};

const EXT_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescript-react",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript-react",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".scala": "scala",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".lua": "lua",
  ".json": "json",
  ".md": "markdown",
  ".markdown": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "css",
  ".less": "css",
};

/** Id языка по расширению (lowercase, с точкой), или null если не индексируем. */
export function languageIdForExt(ext: string): string | null {
  return EXT_TO_LANGUAGE[ext.toLowerCase()] ?? null;
}

/** True, если язык — исходный код (влияет на ранжирование карты). */
export function isCodeLanguage(languageId: string): boolean {
  return RULES[languageId]?.code ?? false;
}

/** Извлекает символы с позициями и kind из содержимого файла. */
export function extractSymbolsDetailed(content: string, languageId: string): SymbolLocation[] {
  const rule = RULES[languageId];
  if (!rule) return [];
  // Дедуп по имени (первое вхождение), затем порядок исходника — outline и
  // список экспортов читаются сверху вниз независимо от порядка regex'ов.
  return dedupe(rule.extract(content))
    .sort((a, b) => a.line - b.line)
    .slice(0, MAX_SYMBOLS_PER_FILE);
}

/** Извлекает публичные/экспортные имена символов (обратная совместимость). */
export function extractSymbols(content: string, languageId: string): string[] {
  return extractSymbolsDetailed(content, languageId).map((s) => s.name);
}

/** Все индексируемые расширения (для доков/тестов). */
export function indexedExtensions(): string[] {
  return Object.keys(EXT_TO_LANGUAGE).sort();
}

/** Паттерны спецификаторов импорта (TS/JS/Python/Rust/Ruby/PHP). */
const IMPORT_PATTERNS: RegExp[] = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(?\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  /^\s*use\s+([A-Za-z_][\w:]*)/gm,
  /^\s*#include\s+["<]([^">]+)[">]/gm,
];

/**
 * Извлекает сырые спецификаторы импорта/require из содержимого. Используется
 * графом ссылок (PageRank): резолв локальных путей — в `graph.ts`. Дубликаты
 * убираются, порядок — первый.
 */
export function extractImports(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const spec = match[1];
      if (spec && !seen.has(spec)) {
        seen.add(spec);
        out.push(spec);
      }
      if (match.index === re.lastIndex) re.lastIndex++;
    }
  }
  return out;
}
