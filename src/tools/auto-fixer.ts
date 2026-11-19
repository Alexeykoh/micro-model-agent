
/** Автофиксы LSP-ошибок tsc (конфликты импортов, неиспользуемые). */
import { extname } from "path";

/** Коды LSP-ошибок, поддающиеся автофиксу. */
const AUTO_FIXABLE_CODES = new Set([
  2307, // Cannot find module (import missing)
  2440, // Import declaration conflicts with local declaration
  6133, // Variable is declared but its value is never read
  2769, // No overload matches this call (simple type mismatches)
]);

/** Исправимая LSP-ошибка. */
export interface LspError {
  file: string;
  line: number;
  column: number;
  length: number;
  code: number;
  message: string;
  severity: "error" | "warning";
}

/** Итог попытки автофикса: что применено, что осталось. */
export interface AutoFixResult {
  fixed: boolean;
  newContent: string;
  applied: string[];
  remaining: LspError[];
}

/**
 * Извлекает LSP-ошибки из вывода tsc.
 * Формат: file(line,col): error TSxxxx: message. Возврат: список ошибок.
 */
export function parseTscOutput(output: string): LspError[] {
  const errors: LspError[] = [];
  const regex = /(.+?)\((\d+),(\d+)\): error TS(\d+): (.+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(output))) {
    errors.push({
      file: match[1],
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      length: 0, // tsc doesn't provide length
      code: parseInt(match[4], 10),
      message: match[5],
      severity: "error",
    });
  }

  return errors;
}

/**
 * Пробует автофиксить LSP-ошибки в TS/JS. Только частые безопасные паттерны:
 * - TS2440: конфликт импорта → переименование через `as`;
 * - TS6133: неиспользуемый импорт → удаление из списка.
 */
export function autoFixErrors(
  filePath: string,
  content: string,
  errors: LspError[],
): AutoFixResult {
  const ext = extname(filePath).toLowerCase();
  const isTsFile = [".ts", ".tsx", ".mts", ".cts"].includes(ext);
  const isJsFile = [".js", ".jsx", ".mjs", ".cjs"].includes(ext);

  if (!isTsFile && !isJsFile) {
    return { fixed: false, newContent: content, applied: [], remaining: errors };
  }

  let newContent = content;
  const applied: string[] = [];
  const remaining: LspError[] = [];

  for (const error of errors) {
    if (!AUTO_FIXABLE_CODES.has(error.code)) {
      remaining.push(error);
      continue;
    }

    try {
      const result = fixError(newContent, error);
      if (result.fixed) {
        newContent = result.newContent;
        applied.push(`TS${error.code}: ${error.message.slice(0, 50)}`);
      } else {
        remaining.push(error);
      }
    } catch {
      remaining.push(error);
    }
  }

  return {
    fixed: applied.length > 0,
    newContent,
    applied,
    remaining,
  };
}

/** Пробует починить одну LSP-ошибку. */
function fixError(
  content: string,
  error: LspError,
): { fixed: boolean; newContent: string } {
  const lines = content.split("\n");
  const lineIndex = error.line - 1;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    return { fixed: false, newContent: content };
  }

  const _line = lines[lineIndex];

  switch (error.code) {
    case 2440: // Import declaration conflicts with local declaration
      return fixImportConflict(lines, lineIndex, error);

    case 6133: // Variable is declared but its value is never read
      return fixUnusedImport(lines, lineIndex, error);

    default:
      return { fixed: false, newContent: content };
  }
}

/**
 * Фикс TS2440: конфликт импорта с локальной декларацией.
 * Стратегия: добавить `as LocalName` к импорту (`foo` → `foo as fooImport`).
 */
function fixImportConflict(
  lines: string[],
  lineIndex: number,
  error: LspError,
): { fixed: boolean; newContent: string } {
  const _line = lines[lineIndex];

  // Конфликтное имя — из текста ошибки.
  const nameMatch = error.message.match(/Import declaration conflicts with local declaration of '(\w+)'/);
  if (!nameMatch) {
    return { fixed: false, newContent: lines.join("\n") };
  }
  const conflictingName = nameMatch[1];

  // Строка импорта (может быть выше текущей) — для TS2440-фикса.
  let importLineIndex = lineIndex;
  while (importLineIndex >= 0 && !lines[importLineIndex].includes("import")) {
    importLineIndex--;
  }

  if (importLineIndex < 0) {
    return { fixed: false, newContent: lines.join("\n") };
  }

  const importLine = lines[importLineIndex];

  // Только именованный импорт вида import { ... } from '...'.
  const namedImportMatch = importLine.match(/import\s+(?:type\s+)?\{([^}]+)\}\s+from/);
  if (!namedImportMatch) {
    return { fixed: false, newContent: lines.join("\n") };
  }

  const imports = namedImportMatch[1];
  const importParts = imports.split(",").map((s) => s.trim());

  // Конфликтное имя — в списке импортов?
  const nameIndex = importParts.findIndex((part) => {
    const baseName = part.split(/\s+as\s+/)[0].trim();
    return baseName === conflictingName;
  });

  if (nameIndex === -1) {
    return { fixed: false, newContent: lines.join("\n") };
  }

  // Алиас уже есть — не трогаем.
  const currentImport = importParts[nameIndex];
  if (currentImport.includes(" as ")) {
    return { fixed: false, newContent: lines.join("\n") };
  }

  // Добавить алиас.
  importParts[nameIndex] = `${conflictingName} as ${conflictingName}Import`;
  lines[importLineIndex] = importLine.replace(
    namedImportMatch[1],
    importParts.join(", "),
  );

  return { fixed: true, newContent: lines.join("\n") };
}

/**
 * Фикс TS6133: объявлена, но не читается. Стратегия: выкинуть неиспользуемый
 * импорт из списка (`{ foo, bar }` → `{ bar }`); пустой импорт — строкой целиком.
 */
function fixUnusedImport(
  lines: string[],
  lineIndex: number,
  error: LspError,
): { fixed: boolean; newContent: string } {
  const _line = lines[lineIndex];

  // Неиспользуемое имя — из текста ошибки.
  const nameMatch = error.message.match(/'(\w+)' is declared but its value is never read/);
  if (!nameMatch) {
    return { fixed: false, newContent: lines.join("\n") };
  }
  const unusedName = nameMatch[1];

  // Строка импорта (может быть выше текущей) — для TS6133-фикса.
  let importLineIndex = lineIndex;
  while (importLineIndex >= 0 && !lines[importLineIndex].includes("import")) {
    importLineIndex--;
  }

  if (importLineIndex < 0) {
    return { fixed: false, newContent: lines.join("\n") };
  }

  const importLine = lines[importLineIndex];

  // Только именованный импорт вида import { ... } from '...' (TS6133).
  const namedImportMatch = importLine.match(/import\s+(?:type\s+)?\{([^}]+)\}\s+from/);
  if (!namedImportMatch) {
    return { fixed: false, newContent: lines.join("\n") };
  }

  const imports = namedImportMatch[1];
  const importParts = imports.split(",").map((s) => s.trim());

  // Найти и выкинуть неиспользуемый импорт.
  const nameIndex = importParts.findIndex((part) => {
    const baseName = part.split(/\s+as\s+/)[0].trim();
    return baseName === unusedName;
  });

  if (nameIndex === -1) {
    return { fixed: false, newContent: lines.join("\n") };
  }

  importParts.splice(nameIndex, 1);

  // Импортов не осталось — снести строку целиком.
  if (importParts.length === 0) {
    lines.splice(importLineIndex, 1);
  } else {
    lines[importLineIndex] = importLine.replace(
      namedImportMatch[1],
      importParts.join(", "),
    );
  }

  return { fixed: true, newContent: lines.join("\n") };
}
