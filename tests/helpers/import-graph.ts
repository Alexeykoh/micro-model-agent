import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Import-graph helpers for webui boundary/cycle guard tests.
 *
 * Parses static + re-export + dynamic imports via the TypeScript AST (no regex
 * masking — the same rationale as `tests/output/no-direct-console.test.ts`),
 * resolves relative specifiers to scanned files, and reports cycles.
 *
 * Only relative specifiers (`./`, `../`) are followed; bare package imports are
 * ignored, since boundaries are about intra-module structure.
 */

export interface ScanFile {
  /** Repo-relative path, forward slashes. */
  path: string;
  text: string;
}

export interface ImportEdge {
  /** Repo-relative path of the resolved target scanned file. */
  target: string;
  /** Raw specifier as written. */
  specifier: string;
  /** 1-based line number of the import. */
  line: number;
  /** `import type` / all-type named bindings — erased at runtime, not a runtime edge. */
  typeOnly: boolean;
}

const KIND_BY_EXT: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".tsx": ts.ScriptKind.TSX,
};
const DEFAULT_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

/** Recursively collect files under `absRoot`, returned as repo-relative paths. */
export function collectFiles(
  absRoot: string,
  repoRoot: string,
  exts: string[],
  opts: { skipTests?: boolean; skipDirs?: ReadonlySet<string> } = {},
): ScanFile[] {
  const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
  const extset = new Set(exts);
  const out: ScanFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      if (!extset.has(ext)) continue;
      if (opts.skipTests && /\.(test|spec)\./.test(entry.name)) continue;
      const full = join(dir, entry.name);
      out.push({
        path: relative(repoRoot, full).replace(/\\/g, "/"),
        text: readFileSync(full, "utf-8"),
      });
    }
  };
  walk(absRoot);
  return out;
}

/** Extract relative import/re-export/dynamic-import specifiers from a file. */
export function collectImports(file: ScanFile): Array<Omit<ImportEdge, "target">> {
  const ext = file.path.slice(file.path.lastIndexOf("."));
  const kind = KIND_BY_EXT[ext] ?? ts.ScriptKind.TS;
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, false, kind);
  const out: Array<Omit<ImportEdge, "target">> = [];
  const visit = (node: ts.Node): void => {
    const ref = relativeImportOf(node);
    if (ref) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
      out.push({ specifier: ref.spec, line: line + 1, typeOnly: ref.typeOnly });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Classify one AST node as a relative import/re-export/dynamic import, or `null`. */
function relativeImportOf(node: ts.Node): { spec: string; typeOnly: boolean } | null {
  const fromImport = importDeclRef(node);
  if (fromImport) return fromImport;
  const fromExport = exportDeclRef(node);
  if (fromExport) return fromExport;
  return dynamicImportRef(node);
}

/** An import declaration whose target is relative (absolute/bare ones are ignored). */
function importDeclRef(node: ts.Node): { spec: string; typeOnly: boolean } | null {
  if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return null;
  return asRelative(node.moduleSpecifier.text, isTypeOnlyImport(node));
}

/** A re-export declaration whose target is relative (absolute/bare ones are ignored). */
function exportDeclRef(node: ts.Node): { spec: string; typeOnly: boolean } | null {
  if (!ts.isExportDeclaration(node) || !node.moduleSpecifier) return null;
  if (!ts.isStringLiteral(node.moduleSpecifier)) return null;
  return asRelative(node.moduleSpecifier.text, isTypeOnlyExport(node));
}

/** A dynamic `import()` whose target is relative (absolute/bare ones are ignored). */
function dynamicImportRef(node: ts.Node): { spec: string; typeOnly: boolean } | null {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
  const arg = node.arguments[0];
  if (!arg || !ts.isStringLiteral(arg)) return null;
  return asRelative(arg.text, false);
}

/** `{ spec, typeOnly }` when relative, else `null` (bare package imports are not followed). */
function asRelative(spec: string, typeOnly: boolean): { spec: string; typeOnly: boolean } | null {
  return spec.startsWith(".") ? { spec, typeOnly } : null;
}

/** `import type …` or a named import where every binding is `type`-marked. */
function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false; // side-effect import (`import "./x"`) is a value edge
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    return bindings.elements.length > 0 && bindings.elements.every((el) => el.isTypeOnly);
  }
  return false;
}

/** `export type … from` or a named re-export where every binding is `type`-marked. */
function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (clause && ts.isNamedExports(clause)) {
    return clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly);
  }
  return false;
}

/** Resolve a relative specifier against the scanned file set (`null` if external). */
export function resolveSpecifier(
  fromPath: string,
  spec: string,
  known: ReadonlySet<string>,
): string | null {
  const base = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const stack: string[] = [];
  for (const seg of `${base}/${spec}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  const joined = stack.join("/");
  const candidates = [
    joined,
    `${joined}.ts`,
    `${joined}.js`,
    `${joined}.mjs`,
    `${joined}/index.ts`,
    `${joined}/index.js`,
  ];
  for (const c of candidates) if (known.has(c)) return c;
  return null;
}

/** Build `path -> resolved relative import edges`. Unresolved edges are dropped. */
export function buildImportGraph(files: ScanFile[]): Map<string, ImportEdge[]> {
  const known = new Set(files.map((f) => f.path));
  const graph = new Map<string, ImportEdge[]>();
  for (const file of files) {
    const edges: ImportEdge[] = [];
    for (const e of collectImports(file)) {
      const target = resolveSpecifier(file.path, e.specifier, known);
      if (target) edges.push({ ...e, target });
    }
    graph.set(file.path, edges);
  }
  return graph;
}

export interface IdentifierRef {
  /** Repo-relative path, forward slashes. */
  path: string;
  /** 1-based line number. */
  line: number;
}

/** Code references to an identifier (AST nodes only — comments/strings are ignored). */
export function findIdentifierRefs(files: ScanFile[], name: string): IdentifierRef[] {
  const out: IdentifierRef[] = [];
  for (const file of files) {
    const ext = file.path.slice(file.path.lastIndexOf("."));
    const kind = KIND_BY_EXT[ext] ?? ts.ScriptKind.TS;
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, false, kind);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === name) {
        out.push({
          path: file.path,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

/**
 * All elementary cycles in the graph (each returned once, in DFS discovery order).
 * Type-only edges are ignored by default: `import type` is erased at runtime, so a
 * value↔type back-edge is not a runtime cycle (a very common TS pattern).
 */
export function findCycles(
  graph: Map<string, ImportEdge[]>,
  opts: { includeTypeOnly?: boolean } = {},
): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const dfs = (node: string): void => {
    visited.add(node);
    stack.push(node);
    onStack.add(node);
    for (const edge of graph.get(node) ?? []) {
      if (!opts.includeTypeOnly && edge.typeOnly) continue;
      if (onStack.has(edge.target)) {
        const cycle = stack.slice(stack.indexOf(edge.target));
        const key = [...cycle].sort().join(">");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (!visited.has(edge.target)) {
        dfs(edge.target);
      }
    }
    stack.pop();
    onStack.delete(node);
  };
  for (const node of graph.keys()) if (!visited.has(node)) dfs(node);
  return cycles;
}
