// W0-спайк: проверяет, что документные зависимости вшиваются в бандл и артефакт
// поднимается БЕЗ `node_modules` (инлайн, а не резолв в рантайме). Запускается как
// собранный `bun build` артефакт из чистой temp-папки (см. docs/specs/...documents-module-design.md §4.6).
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser();
const out = parser.parse("<r><a>1</a></r>");
if (out?.r?.a !== 1 && out?.r?.a !== "1") throw new Error("xml parser bundled incorrectly");
console.log("documents deps bundle OK");
