/**
 * Language registry and symbol extraction for the project index.
 *
 * Adding a language = one entry in `RULES` + one or more extensions in
 * `EXT_TO_LANGUAGE`. Each rule declares whether the language is source code
 * (used for map ranking) and how to pull public/exported symbol names out of
 * a file. Extraction is regex-based on purpose (no parser dependency): it is
 * cheap, runs on every indexed file, and only needs enough structure to make
 * the project map useful — not a full AST.
 */

/** Cap per file so a single generated file cannot blow up the map. */
export const MAX_SYMBOLS_PER_FILE = 40;

interface LanguageRule {
  /** True for programming languages — used to rank files in the map. */
  code: boolean;
  extract: (content: string) => string[];
}

/** Unique preserved-order names. */
function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Collect captured group 1 from a list of global (multiline) regexes. */
function collect(content: string, patterns: RegExp[]): string[] {
  const names: string[] = [];
  for (const re of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      if (match[1]) names.push(match[1]);
      if (match.index === re.lastIndex) re.lastIndex++;
    }
  }
  return names;
}

/** Names from `export { a, b as c }` / `export type { X }` clauses. */
function collectExportClauses(content: string): string[] {
  const names: string[] = [];
  const re = /export\s+(?:type\s+)?\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    for (const part of match[1].split(",")) {
      const cleaned = part.trim().replace(/^type\s+/, "");
      if (!cleaned || cleaned.startsWith("//")) continue;
      const alias = cleaned.split(/\s+as\s+/);
      const exported = (alias.length > 1 ? alias[1] : alias[0]).trim();
      if (/^\w+$/.test(exported)) names.push(exported);
    }
  }
  return names;
}

const TS_JS_PATTERNS = [
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/gm,
  /^export\s+default\s+(?:class|function)\s+(\w+)/gm,
];

function tsLike(content: string): string[] {
  return dedupe([...collect(content, TS_JS_PATTERNS), ...collectExportClauses(content)]);
}

const PYTHON_PATTERNS = [/^(?:async\s+)?def\s+(\w+)/gm, /^class\s+(\w+)/gm];

const RUST_PATTERNS = [
  /^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|const|static|type|mod)\s+(\w+)/gm,
  /macro_rules!\s+(\w+)/g,
];

const GO_PATTERNS = [
  /^func\s+(\w+)\s*[([]/gm,
  /^func\s+\([^)]*\)\s+(\w+)\s*[([]/gm,
  /^type\s+(\w+)/gm,
  /^(?:var|const)\s+(\w+)/gm,
];

const JAVA_PATTERNS = [
  /^\s*(?:(?:public|protected|private|final|abstract|static|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record)\s+(\w+)/gm,
];

const KOTLIN_PATTERNS = [
  /^\s*(?:(?:public|internal|private|protected|open|abstract|sealed|data|enum|annotation|value|inline)\s+)*(?:class|interface|object)\s+(\w+)/gm,
  /^\s*(?:(?:public|internal|private|protected|open|override|suspend|inline|operator|infix|tailrec|external)\s+)*fun\s+(\w+)/gm,
];

const CSHARP_PATTERNS = [
  /^\s*(?:(?:public|internal|private|protected|static|sealed|abstract|partial|readonly|unsafe|new|record)\s+)*(?:class|interface|struct|enum|record)\s+(\w+)/gm,
];

const RUBY_PATTERNS = [/^\s*(?:def|class|module)\s+([A-Za-z_]\w*[?!]?)/gm];

const PHP_PATTERNS = [/\b(?:function|class|interface|trait|enum)\s+(\w+)/g];

const SWIFT_PATTERNS = [/\b(?:func|class|struct|enum|protocol|extension)\s+(\w+)/g];

const SCALA_PATTERNS = [
  /^\s*(?:(?:private|protected|final|abstract|sealed|implicit|lazy|override)\s+)*(?:def|class|object|trait)\s+(\w+)/gm,
];

const C_CPP_PATTERNS = [
  /^\s*(?:typedef\s+)?(?:class|struct|enum|union|namespace)\s+(\w+)/gm,
  /\}\s*(\w+)\s*;/g,
];

const SHELL_PATTERNS = [/^\s*(?:function\s+)?(\w+)\s*\(\s*\)\s*\{/gm];

const LUA_PATTERNS = [/^\s*(?:local\s+)?function\s+([\w.:]+)/gm];

const NO_SYMBOLS = (): string[] => [];

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

/** Language id for a file extension (lowercase, with dot), or null if not indexed. */
export function languageIdForExt(ext: string): string | null {
  return EXT_TO_LANGUAGE[ext.toLowerCase()] ?? null;
}

/** True when the language is source code (affects project-map ranking). */
export function isCodeLanguage(languageId: string): boolean {
  return RULES[languageId]?.code ?? false;
}

/** Extract public/exported symbol names from file content. */
export function extractSymbols(content: string, languageId: string): string[] {
  const rule = RULES[languageId];
  if (!rule) return [];
  return dedupe(rule.extract(content)).slice(0, MAX_SYMBOLS_PER_FILE);
}

/** All indexed extensions (for docs/tests). */
export function indexedExtensions(): string[] {
  return Object.keys(EXT_TO_LANGUAGE).sort();
}
