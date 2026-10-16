/** Публичный экспорт модуля документов (W1): определение, реестр, типы IR. */
export { documentsModuleDef } from "./module";
export { buildRegistry, ACTIVE_GROUPS, DOCUMENTS_ENABLED } from "./registry";
export type { DocumentRegistry, RegistryHealth } from "./registry";
export type { DocBlock, DocNode, DocTable, DocumentIR } from "./ir";
export type { DocumentHandler, HandlerGroup } from "./handler";
// W5 — индексация корпуса и поиск.
export { chunkIR, DEFAULT_MAX_CHUNK_CHARS, DEFAULT_MAX_CHUNKS_PER_DOC } from "./chunks";
export type { ChunkOptions, DocChunk } from "./chunks";
export {
  buildEntries,
  CACHE_VERSION,
  DocumentsCache,
  fingerprint,
  indexDir,
  inventoryDir,
  MAX_DOCUMENTS,
  MAX_INDEX_DEPTH,
  MAX_TOTAL_CHUNKS,
} from "./corpus";
export { reconcile } from "./reconcile";
export type {
  BuildEntriesOptions,
  BuildEntriesResult,
  DocEntry,
  DocumentsCacheOptions,
  IndexDirOptions,
  IndexDirResult,
  InventoryDirOptions,
  InventoryDirResult,
  InventoryItem,
  WalkLimits,
} from "./corpus";
export type { ReconcileOptions, ReconcileResult } from "./reconcile";
export { FIND_LIMIT, SNIPPET_CHARS, searchChunks } from "./search";
export type { SearchHit } from "./search";
