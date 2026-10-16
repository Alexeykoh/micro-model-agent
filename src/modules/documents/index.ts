/** Публичный экспорт модуля документов (W1): определение, реестр, типы IR. */
export { documentsModuleDef } from "./module";
export { buildRegistry } from "./registry";
export type { DocumentRegistry, RegistryHealth } from "./registry";
export type { DocBlock, DocNode, DocTable, DocumentIR } from "./ir";
export type { DocumentHandler, HandlerGroup } from "./handler";
