import { readFileSync, writeFileSync } from "fs";
import { extname } from "path";

/**
 * LSP error codes that can be auto-fixed.
 */
const AUTO_FIXABLE_CODES = new Set([
  2307, // Cannot find module (import missing)
  2440, // Import declaration conflicts with local declaration
  6133, // Variable is declared but its value is never read
  2769, // No overload matches this call (simple type mismatches)
]);

/**
 * Represents a fixable LSP error.
 */
export interface LspError {
  file: string;
  line: number;
  column: number;
  length: number;
  code: number;
  message: string;
  severity: "error" | "warning";
}

/**
 * Result of an auto-fix attempt.
 */
export interface AutoFixResult {
  fixed: boolean;
  newContent: string;
  applied: string[];
  remaining: LspError[];
}

/**
 * Extract LSP errors from tsc output.
 * Format: file(line,col): error TSxxxx: message
 */
export function parseTscOutput(output: string): LspError[] {
  const errors: LspError[] = [];
  const regex = /(.+?)\((\d+),(\d+)\): error TS(\d+): (.+)/g;
  let match;

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
 * Try to auto-fix LSP errors in TypeScript/JavaScript code.
 * Only fixes common, safe patterns:
 * - TS2440: Import conflict → rename import with `as`
 * - TS6133: Unused import → remove from import list
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

/**
 * Try to fix a single LSP error.
 */
function fixError(
  content: string,
  error: LspError,
): { fixed: boolean; newContent: string } {
  const lines = content.split("\n");
  const lineIndex = error.line - 1;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    return { fixed: false, newContent: content };
  }

  const line = lines[lineIndex];

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
 * Fix TS2440: Import declaration conflicts with local declaration.
 * Strategy: Add `as LocalName` to the import.
 *
 * Example:
 *   import { foo } from './module';
 *   export function foo() { ... }
 * Becomes:
 *   import { foo as fooImport } from './module';
 *   export function foo() { ... }
 */
function fixImportConflict(
  lines: string[],
  lineIndex: number,
  error: LspError,
): { fixed: boolean; newContent: string } {
  const line = lines[lineIndex];

  // Find the conflicting name in the error message
  const nameMatch = error.message.match(/Import declaration conflicts with local declaration of '(\w+)'/);
  if (!nameMatch) {
    return { fixed: false, newContent: lines.join("\n") };
  }
  const conflictingName = nameMatch[1];

  // Find the import line (might be above the current line)
  let importLineIndex = lineIndex;
  while (importLineIndex >= 0 && !lines[importLineIndex].includes("import")) {
    importLineIndex--;
  }

  if (importLineIndex < 0) {
    return { fixed: false, newContent: lines.join("\n") };
  }

  const importLine = lines[importLineIndex];

  // Check if this is a named import: import { ... } from '...'
  const namedImportMatch = importLine.match(/import\s+(?:type\s+)?\{([^}]+)\}\s+from/);
  if (!namedImportMatch) {
    return { fixed: false, newContent: lines.join("\n") };
  }

  const imports = namedImportMatch[1];
  const importParts = imports.split(",").map((s) => s.trim());

  // Check if the conflicting name is in the imports
  const nameIndex = importParts.findIndex((part) => {
    const baseName = part.split(/\s+as\s+/)[0].trim();
    return baseName === conflictingName;
  });

  if (nameIndex === -1) {
    return { fixed: false, newContent: lines.join("\n") };
  }

  // Check if already has an alias
  const currentImport = importParts[nameIndex];
  if (currentImport.includes(" as ")) {
    return { fixed: false, newContent: lines.join("\n") };
  }

  // Add alias
  importParts[nameIndex] = `${conflictingName} as ${conflictingName}Import`;
  lines[importLineIndex] = importLine.replace(
    namedImportMatch[1],
    importParts.join(", "),
  );

  return { fixed: true, newContent: lines.join("\n") };
}

/**
 * Fix TS6133: Variable is declared but its value is never read.
 * Strategy: Remove the unused import from the import list.
 *
 * Example:
 *   import { foo, bar } from './module';
 *   console.log(bar);
 * Becomes:
 *   import { bar } from './module';
 *   console.log(bar);
 */
function fixUnusedImport(
  lines: string[],
  lineIndex: number,
  error: LspError,
): { fixed: boolean; newContent: string } {
  const line = lines[lineIndex];

  // Find the unused name in the error message
  const nameMatch = error.message.match(/'(\w+)' is declared but its value is never read/);
  if (!nameMatch) {
    return { fixed: false, newContent: lines.join("\n") };
  }
  const unusedName = nameMatch[1];

  // Find the import line (might be above the current line)
  let importLineIndex = lineIndex;
  while (importLineIndex >= 0 && !lines[importLineIndex].includes("import")) {
    importLineIndex--;
  }

  if (importLineIndex < 0) {
    return { fixed: false, newContent: lines.join("\n") };
  }

  const importLine = lines[importLineIndex];

  // Check if this is a named import: import { ... } from '...'
  const namedImportMatch = importLine.match(/import\s+(?:type\s+)?\{([^}]+)\}\s+from/);
  if (!namedImportMatch) {
    return { fixed: false, newContent: lines.join("\n") };
  }

  const imports = namedImportMatch[1];
  const importParts = imports.split(",").map((s) => s.trim());

  // Find and remove the unused import
  const nameIndex = importParts.findIndex((part) => {
    const baseName = part.split(/\s+as\s+/)[0].trim();
    return baseName === unusedName;
  });

  if (nameIndex === -1) {
    return { fixed: false, newContent: lines.join("\n") };
  }

  importParts.splice(nameIndex, 1);

  // If no imports left, remove the entire import line
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
