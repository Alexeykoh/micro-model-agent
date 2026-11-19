// Контракт внешнего источника определений символа (LSP `workspace/symbol`).
//
// Вынесен из `module.ts`: этим типом пользуются и модуль, и форматтер
// (`format.ts`), поэтому он не должен жить в одном из них (правило 6 AGENTS).

/** Локация символа, отданная внешним провайдером (LSP workspace/symbol). */
export interface SymbolLocationHit {
  path: string;
  line: number;
  name: string;
  kind: string;
}

/** Внешний источник определений символа (LSP); null-совместим с фолбэком на индекс. */
export type SymbolProvider = (query: string, language: string) => Promise<SymbolLocationHit[]>;
