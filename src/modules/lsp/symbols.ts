/**
 * Разбор ответа LSP `workspace/symbol` в плоские локации для карты проекта.
 *
 * `workspace/symbol` — правильный LSP-примитив для поиска символа ПО ИМЕНИ
 * (`textDocument/definition` требует позицию), поэтому именно им обогащается
 * действие `project_map symbol`, когда индекс не нашёл совпадений.
 */
import { relative } from "path";
import { uriToPath } from "./uri";

/** Локация символа из LSP, приведённая к виду карты проекта. */
export interface LspSymbolLocation {
  name: string;
  kind: string;
  /** Путь относительно корня проекта (forward slashes). */
  path: string;
  /** 1-based номер строки. */
  line: number;
}

const SYMBOL_KINDS: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum-member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type-parameter",
};

/** Человеческое имя LSP SymbolKind (число → строка). */
export function symbolKindName(kind: number | undefined): string {
  return (kind !== undefined && SYMBOL_KINDS[kind]) || "symbol";
}

/** Нормализует ответ `workspace/symbol` в локации относительно корня проекта. */
export function mapWorkspaceSymbols(result: unknown, projectRoot: string): LspSymbolLocation[] {
  if (!Array.isArray(result)) return [];
  const out: LspSymbolLocation[] = [];
  for (const entry of result) {
    if (!entry || typeof entry !== "object") continue;
    const sym = entry as Record<string, unknown>;
    const name = typeof sym.name === "string" ? sym.name : "";
    const location = (sym.location ?? sym) as Record<string, unknown>;
    const uri = typeof location.uri === "string" ? location.uri : "";
    if (!name || !uri) continue;
    const range = location.range as { start?: { line?: number } } | undefined;
    const line = (range?.start?.line ?? 0) + 1;
    const path = relative(projectRoot, uriToPath(uri)).replace(/\\/g, "/");
    out.push({ name, kind: symbolKindName(sym.kind as number | undefined), path, line });
  }
  return out;
}
