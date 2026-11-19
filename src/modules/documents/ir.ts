/**
 * Нормализованное представление документа (INV-D2): формат-агностичное.
 * Все обработчики форматов сводят документ к `DocumentIR`; потребители
 * (`map`/`read`/`index`) видят только этот тип.
 */
export interface DocumentIR {
  meta: DocumentMeta;
  outline: DocNode[];
  blocks: DocBlock[];
}
export interface DocumentMeta {
  format: string;
  title?: string;
  pages?: number;
  sheets?: string[];
  bytes: number;
  degraded?: { reason: string };
}
export interface DocNode {
  id: string;
  level: number;
  title: string;
  kind: "doc" | "sheet" | "section" | "slide";
}
export type DocBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; lang?: string; text: string }
  | { kind: "table"; table: DocTable }
  | { kind: "figure"; caption?: string; ref: FigureRef };
export interface DocTable {
  caption?: string;
  header: string[];
  rows: string[][];
  range?: string;
  truncated?: boolean;
}
export interface FigureRef {
  kind: "raster" | "vector";
  mime: string;
  bytes: number;
  note?: string;
}
/** Пустой IR с заданным форматом (база для обработчиков). */
export function emptyIR(format: string, bytes: number): DocumentIR {
  return { meta: { format, bytes }, outline: [], blocks: [] };
}
