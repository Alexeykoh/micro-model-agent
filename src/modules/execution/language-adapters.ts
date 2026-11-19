// Syntax adapters for the verifier (spec 2026-11-03-language-adapters-design).
// TS/JS keep their dedicated branches; this table covers the languages that used
// to return "syntax ok" without checking anything.
export type SyntaxCheck =
  | { kind: "command"; command: (file: string) => string; timeoutMs: number }
  | { kind: "json" };

const COMMAND_ADAPTERS: Record<string, { bin: string; args: (f: string) => string; ms: number }> = {
  ".py": { bin: "python", args: (f) => `-m py_compile "${f}"`, ms: 10_000 },
  ".pyi": { bin: "python", args: (f) => `-m py_compile "${f}"`, ms: 10_000 },
  ".rb": { bin: "ruby", args: (f) => `-c "${f}"`, ms: 10_000 },
  ".php": { bin: "php", args: (f) => `-l "${f}"`, ms: 10_000 },
  ".sh": { bin: "bash", args: (f) => `-n "${f}"`, ms: 10_000 },
  ".bash": { bin: "bash", args: (f) => `-n "${f}"`, ms: 10_000 },
};

/** Null for extensions the verifier handles elsewhere (TS/JS) or ignores. */
export function adapterForExt(ext: string): SyntaxCheck | null {
  const key = ext.toLowerCase();
  if (key === ".json") return { kind: "json" };
  const a = COMMAND_ADAPTERS[key];
  if (!a) return null;
  return {
    kind: "command",
    timeoutMs: a.ms,
    command: (file) => `${a.bin} ${a.args(file)}`,
  };
}
