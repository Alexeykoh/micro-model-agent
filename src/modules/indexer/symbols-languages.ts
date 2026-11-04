import { MAX_SYMBOLS_PER_FILE, type SymbolLocation } from "./symbols-types";
import { RULES, dedupe } from "./symbols-rules";

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

