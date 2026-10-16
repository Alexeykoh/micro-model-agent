/**
 * ЕДИНСТВЕННАЯ точка включения/выключения поддержки — в коде, без настроек (INV-D3).
 * Убрал обработчик из `HANDLERS` или группу из `ACTIVE_GROUPS` — формат и его
 * зависимости выпадают из сборки.
 */
import type { DocumentHandler, HandlerGroup } from "../handler";
import { csvHandler, tsvHandler } from "./csv";
import { docxHandler } from "./docx";
import { htmlHandler } from "./html";
import { jsonHandler } from "./json";
import { mdHandler } from "./md";
import { odsHandler } from "./ods";
import { odtHandler } from "./odt";
import { pptxHandler } from "./pptx";
import { xlsxHandler } from "./xlsx";
import { xmlHandler } from "./xml";
import { yamlHandler } from "./yaml";

/** Глобальный выключатель всего модуля. */
export const DOCUMENTS_ENABLED = true;

/** Включаемые группы целиком (убрал группу — её обработчики и зависимости выпадают). */
export const ACTIVE_GROUPS: readonly HandlerGroup[] = [
  "text",
  "spreadsheet",
  "office",
  // "pdf", "image", "geo",  // → W3–W4
];

/** Точный список обработчиков (убрал строку — формат выключен). */
export const HANDLERS: readonly DocumentHandler[] = [
  csvHandler,
  tsvHandler,
  mdHandler,
  jsonHandler,
  yamlHandler,
  xmlHandler,
  htmlHandler,
  xlsxHandler,
  odsHandler,
  docxHandler,
  odtHandler,
  pptxHandler,
  // pdfHandler,                                      // → W3
  // imageHandler, geoHandler,                        // → W4
];
