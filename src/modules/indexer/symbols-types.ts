// Public types and limits for the regex-based symbol scanner. Kept separate so
// the language tables, the rules and the public barrel can all share them
// without an import cycle (rule 6).

/** Cap per file: generated files can contain thousands of declarations. */
export const MAX_SYMBOLS_PER_FILE = 40;

/** One declaration: name, 1-based line, kind, signature. */
export interface SymbolLocation {
  name: string;
  line: number;
  kind: string;
  /** Text up to the body/`;` - a hint, not a parsed AST. */
  signature?: string;
}

/** Max signature length (keeps an API block from swallowing the whole file). */
export const MAX_SIGNATURE_CHARS = 160;
