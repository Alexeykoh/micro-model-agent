# Модуль документов — план реализации (W0+W1 детально, W2–W5 дорожной картой)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить в MMA модуль `documents` — единый субстрат (карта, чтение, индексация)
с реестром обработчиков форматов, включаемый/выключаемый **в коде**, без настроек.

**Architecture:** Модуль `src/modules/documents/` по контракту `ModuleDef`
(`src/core/module-host.ts`). Обработчики форматов приводят всё к `DocumentIR`;
потребители (`map`/`read`/`index`) видят только `DocumentIR`. Вкл/выкл — массив
`HANDLERS` + `ACTIVE_GROUPS` + `DOCUMENTS_ENABLED` в `handlers/index.ts`. Зависимости
форматов вшиваются в билд отдельным шагом; отключённый обработчик выпадает из бандла.

**Tech Stack:** Bun + TypeScript (strict, NodeNext), vitest через `bun test`. W0: `bun build`.
W2: `fast-xml-parser`. W3: `pdfjs-dist`.

**Спека:** [2026-10-16-documents-module-design.md](../specs/2026-10-16-documents-module-design.md)

---

## File Structure (W1)

| Файл | Ответственность |
|---|---|
| `src/modules/documents/ir.ts` | Типы `DocumentIR`/`DocNode`/`DocBlock`/`DocTable`/`FigureRef` |
| `src/modules/documents/handler.ts` | `DocumentHandler`, `HandlerGroup`, `DocSource`, `ParseContext` |
| `src/modules/documents/bound.ts` | Ограничение текста/таблиц (INV-D4) |
| `src/modules/documents/registry.ts` | `buildRegistry`, `DocumentRegistry`: resolve/detect/parse/health |
| `src/modules/documents/handlers/index.ts` | **Точка вкл/выкл в коде** (`DOCUMENTS_ENABLED`/`ACTIVE_GROUPS`/`HANDLERS`) |
| `src/modules/documents/handlers/csv.ts` | CSV/TSV → `DocumentIR` |
| `src/modules/documents/handlers/md.ts` | Markdown → `DocumentIR` |
| `src/modules/documents/handlers/json.ts` | JSON → `DocumentIR` |
| `src/modules/documents/handlers/yaml.ts` | YAML → `DocumentIR` |
| `src/modules/documents/handlers/xml.ts` | XML → `DocumentIR` |
| `src/modules/documents/handlers/html.ts` | HTML → `DocumentIR` |
| `src/modules/documents/map.ts` | `renderDocumentMap(ir)` — «карта» |
| `src/modules/documents/read.ts` | `parseSelector` + `renderDocumentRead(ir, sel)` |
| `src/modules/documents/tools/document-map.ts` | Тул `document_map` |
| `src/modules/documents/tools/document-read.ts` | Тул `document_read` |
| `src/modules/documents/module.ts` | `DocumentsModule` (объект), `documentsModuleDef` |
| `src/modules/documents/index.ts` | Публичный экспорт |
| `src/core/bootstrap/modules-phase.ts` | Регистрация модуля (modify) |
| `src/tools/auto-tags.ts` | Тег `document` в `KNOWN_TOOL_TAGS` (modify) |
| `src/i18n/locales/{en,ru}.json` | Ключи `documents.*`, `tool.friendly.document_*` (modify) |

---

# W0 — Спайк бандлинга зависимостей

Блокирующий спайк: подтвердить, что документные зависимости **вшиваются в `dist/`** и
`dist/` поднимается без `node_modules` этих пакетов. Пока не пройден — W1 не начинаем.

### Task W0.1: Проверить бандлинг `fast-xml-parser` (заглушка-импорт)

**Files:**
- Create: `scripts/documents-bundle-check.ts`
- Modify: `package.json:35` (добавить `build:documents` при подтверждении)

- [ ] **Step 1: Установить зависимость в dev-окружение**

Run: `bun add fast-xml-parser`
Expected: пакет в `dependencies`, `bun.lock` обновлён.

- [ ] **Step 2: Написать проверочный скрипт**

```ts
// scripts/documents-bundle-check.ts
import { XMLParser } from "fast-xml-parser";
const parser = new XMLParser();
const out = parser.parse("<r><a>1</a></r>");
if (out?.r?.a !== 1 && out?.r?.a !== "1") throw new Error("xml parser bundled incorrectly");
console.log("documents deps bundle OK");
```

- [ ] **Step 3: Собрать с инлайном только этого пакета**

Run: `bun build ./scripts/documents-bundle-check.ts --outfile ./tmp/doc-bundle-check.js --target node --format esm`
Expected: сборка без ошибок, размер `tmp/doc-bundle-check.js` > 1 КБ (пакет внутри).

- [ ] **Step 4: Запустить артефакт без `node_modules` пакета**

Run (в отдельной temp-папке без node_modules): `node tmp/doc-bundle-check.js`
Expected: `documents deps bundle OK`.

- [ ] **Step 5: Зафиксировать результат в спеке и коммит**

Дописать в спеку §4.6 фактический результат (сработало / размер). Затем:

```bash
git add scripts/documents-bundle-check.ts package.json bun.lock docs/specs/2026-10-16-documents-module-design.md
git commit -m "build(documents): спайк бандлинга fast-xml-parser (W0)"
```

### Task W0.2: Проверить бандлинг `pdfjs-dist`

- [ ] **Step 1:** `bun add pdfjs-dist`
- [ ] **Step 2:** Расширить `scripts/documents-bundle-check.ts` вызовом legacy text-extraction на минимальном PDF-fixture (1 страница «Hello»).
- [ ] **Step 3:** `bun build ... --outfile ./tmp/doc-pdf-check.js --target node --format esm`; запустить без node_modules.
- [ ] **Step 4 (развилка):** если worker/ESM не бандлится — зафиксировать это в спеке §4.6 и выбрать фолбэк (лёгкий чистый TS-экстрактор текстового слоя), завести запись в `docs/agents/debt.md`.
- [ ] **Step 5:** Коммит `build(documents): спайк бандлинга pdfjs-dist (W0)`.

### Task W0.3: Шаг сборки `build:documents` и подключение в `build:prod`

- [ ] **Step 1:** Добавить в `package.json` скрипт, инлайнящий документные зависимости в `dist/main.js` (не трогая `playwright`).
- [ ] **Step 2:** Вставить шаг в `build:prod` перед `build:optimize`.
- [ ] **Step 3:** `bun run build:prod`; проверить, что `dist/main.js` содержит код `fast-xml-parser`.
- [ ] **Step 4:** Коммит `build(documents): шаг вшивания документных зависимостей (W0)`.

---

# W1 — Субстрат и текстовая группа

Ветка `feat/documents-substrate` от `master`. Результат: чтение и карта текстовых
документов (csv/tsv/md/json/yaml/xml/html) по-настоящему; гейт зелёный.

### Task 1: Типы `DocumentIR`

**Files:**
- Create: `src/modules/documents/ir.ts`
- Test: `tests/documents/ir.test.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
// tests/documents/ir.test.ts
import { describe, expect, it } from "vitest";
import { emptyIR, type DocumentIR } from "../../src/modules/documents/ir";

describe("DocumentIR", () => {
  it("emptyIR несёт формат и нулевые блоки", () => {
    const ir: DocumentIR = emptyIR("txt", 12);
    expect(ir.meta.format).toBe("txt");
    expect(ir.meta.bytes).toBe(12);
    expect(ir.outline).toEqual([]);
    expect(ir.blocks).toEqual([]);
  });
});
```

- [ ] **Step 2: Запустить — упасть**

Run: `bun test tests/documents/ir.test.ts`
Expected: FAIL — «Cannot find module .../ir».

- [ ] **Step 3: Реализовать типы**

```ts
// src/modules/documents/ir.ts
/** Нормализованное представление документа (INV-D2): формат-агностичное. */
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
```

- [ ] **Step 4: Запустить — пройти**

Run: `bun test tests/documents/ir.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/documents/ir.ts tests/documents/ir.test.ts
git commit -m "feat(documents): типы DocumentIR (W1)"
```

### Task 2: Контракт обработчика

**Files:**
- Create: `src/modules/documents/handler.ts`
- Test: `tests/documents/handler.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
// tests/documents/handler.test.ts
import { describe, expect, it } from "vitest";
import { detectHead, type DocumentHandler } from "../../src/modules/documents/handler";

describe("DocumentHandler", () => {
  it("detectHead распознаёт ZIP и PDF по magic-bytes", () => {
    expect(detectHead(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe("zip");
    expect(detectHead(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe("pdf");
    expect(detectHead(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBe("svg");
    expect(detectHead(new Uint8Array([0x68, 0x69]))).toBe("unknown");
  });
});
```

- [ ] **Step 2: Запустить — упасть**

Run: `bun test tests/documents/handler.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать контракт**

```ts
// src/modules/documents/handler.ts
import type { Logger } from "../../logger/app-logger";
import type { DocumentIR } from "./ir";

/** Группа форматов — единица грубого включения/выключения в коде (INV-D3). */
export type HandlerGroup = "text" | "spreadsheet" | "office" | "pdf" | "image" | "geo";

/** Лимиты вывода, передаются обработчику (INV-D4). */
export interface DocLimits {
  maxLines: number;
  maxChars: number;
  maxTableRows: number;
}

/** Источник документа: путь + ленивое чтение байтов. */
export interface DocSource {
  path: string;
  ext: string;
  bytes(): Promise<Uint8Array>;
}

/** Контекст разбора. */
export interface ParseContext {
  logger: Logger;
  limits: DocLimits;
}

/** Обработчик формата. Потребители знают только DocumentHandler (INV-D2). */
export interface DocumentHandler {
  id: string;
  group: HandlerGroup;
  extensions: string[];
  mediaTypes?: string[];
  /** Проверка содержимого по первым байтам; при отсутствии — доверяем расширению. */
  detect?(head: Uint8Array): boolean;
  parse(ctx: ParseContext, source: DocSource): Promise<DocumentIR>;
}

/** Класс содержимого по magic-bytes (расширению доверяем только как подсказке). */
export function detectHead(head: Uint8Array): "zip" | "pdf" | "svg" | "unknown" {
  const b = head;
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05)) return "zip";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf";
  if (b[0] === 0x3c && (b[1] === 0x73 || b[1] === 0x53)) {
    // "<svg ..." или "<SVG" (проверяем первые 4 символа как ascii)
    const s = String.fromCharCode(...b.slice(0, 4)).toLowerCase();
    if (s.startsWith("<svg")) return "svg";
  }
  return "unknown";
}
```

- [ ] **Step 4: Запустить — пройти**

Run: `bun test tests/documents/handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/documents/handler.ts tests/documents/handler.test.ts
git commit -m "feat(documents): контракт DocumentHandler (W1)"
```

### Task 3: Ограничители вывода

**Files:**
- Create: `src/modules/documents/bound.ts`
- Test: `tests/documents/bound.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
// tests/documents/bound.test.ts
import { describe, expect, it } from "vitest";
import { boundTable, boundText, DEFAULT_DOC_LIMITS } from "../../src/modules/documents/bound";

describe("bound", () => {
  it("обрезает текст по строкам с маркером", () => {
    const out = boundText("a\nb\nc\nd", { ...DEFAULT_DOC_LIMITS, maxLines: 2 });
    expect(out).toContain("[...truncated 2 lines...]");
    expect(out.split("\n")[0]).toBe("a");
  });
  it("обрезает таблицу и ставит truncated", () => {
    const t = boundTable({ header: ["h"], rows: [["1"], ["2"], ["3"]] }, { ...DEFAULT_DOC_LIMITS, maxTableRows: 1 });
    expect(t.rows).toHaveLength(1);
    expect(t.truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить — упасть** — `bun test tests/documents/bound.test.ts` → FAIL.

- [ ] **Step 3: Реализовать**

```ts
// src/modules/documents/bound.ts
import type { DocLimits } from "./handler";
import type { DocTable } from "./ir";

export const DEFAULT_DOC_LIMITS: DocLimits = { maxLines: 400, maxChars: 24_000, maxTableRows: 50 };

/** Обрезает текст до maxLines/maxChars с явным маркером (INV-D4). */
export function boundText(text: string, limits: DocLimits): string {
  let lines = text.split("\n");
  let marker = "";
  if (lines.length > limits.maxLines) {
    marker = `\n[...truncated ${lines.length - limits.maxLines} lines...]`;
    lines = lines.slice(0, limits.maxLines);
  }
  let out = lines.join("\n") + marker;
  if (out.length > limits.maxChars) {
    out = `${out.slice(0, limits.maxChars)}\n[...truncated to ${limits.maxChars} chars...]`;
  }
  return out;
}

/** Обрезает таблицу по числу строк, выставляя truncated (INV-D4). */
export function boundTable(table: DocTable, limits: DocLimits): DocTable {
  if (table.rows.length <= limits.maxTableRows) return table;
  return { ...table, rows: table.rows.slice(0, limits.maxTableRows), truncated: true };
}
```

- [ ] **Step 4: Запустить — пройти** — `bun test tests/documents/bound.test.ts` → PASS.
- [ ] **Step 5: Коммит** `feat(documents): ограничители вывода (W1)`.

### Task 4: Текстовые обработчики CSV и Markdown

**Files:**
- Create: `src/modules/documents/handlers/csv.ts`, `src/modules/documents/handlers/md.ts`
- Test: `tests/documents/handlers-text.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
// tests/documents/handlers-text.test.ts
import { describe, expect, it } from "vitest";
import { csvHandler } from "../../src/modules/documents/handlers/csv";
import { mdHandler } from "../../src/modules/documents/handlers/md";
import { DEFAULT_DOC_LIMITS } from "../../src/modules/documents/bound";
import type { Logger } from "../../src/logger/app-logger";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const ctx = { logger, limits: DEFAULT_DOC_LIMITS };
const src = (path: string, text: string) => ({ path, ext: path.slice(path.lastIndexOf(".")), bytes: async () => new TextEncoder().encode(text) });

describe("csvHandler", () => {
  it("первую строку делает заголовком таблицы", async () => {
    const ir = await csvHandler.parse(ctx, src("data.csv", "a,b\n1,2\n3,4"));
    const table = ir.blocks[0];
    expect(table.kind).toBe("table");
    if (table.kind === "table") {
      expect(table.table.header).toEqual(["a", "b"]);
      expect(table.table.rows).toEqual([["1", "2"], ["3", "4"]]);
    }
  });
});

describe("mdHandler", () => {
  it("заголовки попадают в outline", async () => {
    const ir = await mdHandler.parse(ctx, src("r.md", "# Title\n\ntext\n\n## Sub"));
    expect(ir.meta.title).toBe("Title");
    expect(ir.outline.map((n) => n.title)).toEqual(["Title", "Sub"]);
  });
});
```

- [ ] **Step 2: Запустить — упасть** — `bun test tests/documents/handlers-text.test.ts` → FAIL.

- [ ] **Step 3: Реализовать CSV**

```ts
// src/modules/documents/handlers/csv.ts
import { boundTable } from "../bound";
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR } from "../ir";

/** Простой CSV/TSV-парсер: кавычки, разделители, CRLF. */
function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.length > 0));
}

function make(id: string, extensions: string[], sep: string): DocumentHandler {
  return {
    id,
    group: "text",
    extensions,
    detect: (h) => detectHead(h) === "unknown",
    async parse(ctx: ParseContext, source: DocSource) {
      const text = new TextDecoder().decode(await source.bytes());
      const ir = emptyIR(id, text.length);
      const rows = parseDelimited(text, sep);
      const header = rows.shift() ?? [];
      ir.blocks.push({ kind: "table", table: boundTable({ header, rows }, ctx.limits) });
      ir.meta.title = source.path;
      ir.outline.push({ id: "t0", level: 1, title: source.path, kind: "section" });
      return ir;
    },
  };
}

export const csvHandler = make("csv", [".csv"], ",");
export const tsvHandler = make("tsv", [".tsv", ".tab"], "\t");
```

- [ ] **Step 4: Реализовать Markdown**

```ts
// src/modules/documents/handlers/md.ts
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR, type DocBlock } from "../ir";

/** Markdown → IR: заголовки → outline+heading, остальное — абзацы/код. */
export const mdHandler: DocumentHandler = {
  id: "md",
  group: "text",
  extensions: [".md", ".markdown", ".mdown"],
  detect: (h) => detectHead(h) === "unknown",
  async parse(ctx: ParseContext, source: DocSource) {
    const text = new TextDecoder().decode(await source.bytes());
    const ir = emptyIR("md", text.length);
    const lines = text.split(/\r?\n/);
    let para: string[] = [];
    let code: string[] | null = null;
    let n = 0;
    const flushPara = () => {
      if (para.length) { ir.blocks.push({ kind: "paragraph", text: para.join(" ").trim() }); para = []; }
    };
    for (const line of lines) {
      if (line.startsWith("```")) {
        if (code) { ir.blocks.push({ kind: "code", text: code.join("\n") } as DocBlock); code = null; }
        else { flushPara(); code = []; }
        continue;
      }
      if (code) { code.push(line); continue; }
      const m = /^(#{1,6})\s+(.*)$/.exec(line);
      if (m) {
        flushPara();
        const level = m[1].length;
        const title = m[2].trim();
        ir.blocks.push({ kind: "heading", level, text: title });
        ir.outline.push({ id: `h${n++}`, level, title, kind: "section" });
        if (level === 1 && !ir.meta.title) ir.meta.title = title;
        continue;
      }
      if (line.trim() === "") flushPara();
      else para.push(line.trim());
    }
    flushPara();
    return ir;
  },
};
```

- [ ] **Step 5: Запустить — пройти** — `bun test tests/documents/handlers-text.test.ts` → PASS.
- [ ] **Step 6: Коммит** `feat(documents): обработчики csv/tsv/md (W1)`.

### Task 5: Обработчики JSON, YAML, XML, HTML

**Files:**
- Create: `src/modules/documents/handlers/json.ts`, `yaml.ts`, `xml.ts`, `html.ts`
- Test: `tests/documents/handlers-text2.test.ts`

- [ ] **Step 1: Падающий тест** (по одному кейсу на файл)

```ts
// tests/documents/handlers-text2.test.ts
import { describe, expect, it } from "vitest";
import { jsonHandler } from "../../src/modules/documents/handlers/json";
import { yamlHandler } from "../../src/modules/documents/handlers/yaml";
import { xmlHandler } from "../../src/modules/documents/handlers/xml";
import { htmlHandler } from "../../src/modules/documents/handlers/html";
import { DEFAULT_DOC_LIMITS } from "../../src/modules/documents/bound";
import type { Logger } from "../../src/logger/app-logger";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const ctx = { logger, limits: DEFAULT_DOC_LIMITS };
const src = (path: string, text: string) => ({ path, ext: path.slice(path.lastIndexOf(".")), bytes: async () => new TextEncoder().encode(text) });

describe("json/yaml/xml/html", () => {
  it("json отдаёт code-блок с top-level ключами в outline", async () => {
    const ir = await jsonHandler.parse(ctx, src("c.json", '{"a":1,"b":2}'));
    expect(ir.outline.map((n) => n.title)).toEqual(["a", "b"]);
  });
  it("yaml даёт outline по ключам верхнего уровня", async () => {
    const ir = await yamlHandler.parse(ctx, src("c.yaml", "a: 1\nb: 2\n"));
    expect(ir.outline.map((n) => n.title)).toEqual(["a", "b"]);
  });
  it("xml извлекает теги верхнего уровня", async () => {
    const ir = await xmlHandler.parse(ctx, src("c.xml", "<r><a/><b/></r>"));
    expect(ir.outline.length).toBeGreaterThan(0);
  });
  it("html вынимает title и заголовки", async () => {
    const ir = await htmlHandler.parse(ctx, src("p.html", "<html><head><title>T</title></head><body><h1>H</h1><p>x</p></body></html>"));
    expect(ir.meta.title).toBe("T");
    expect(ir.outline.some((n) => n.title === "H")).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить — упасть** — FAIL.

- [ ] **Step 3: Реализовать `json.ts`**

```ts
// src/modules/documents/handlers/json.ts
import { boundText } from "../bound";
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR } from "../ir";

/** JSON → IR: верхнеуровневые ключи в outline, форматированный JSON — code-блок. */
export const jsonHandler: DocumentHandler = {
  id: "json",
  group: "text",
  extensions: [".json", ".jsonc"],
  detect: (h) => detectHead(h) === "unknown",
  async parse(ctx: ParseContext, source: DocSource) {
    const text = new TextDecoder().decode(await source.bytes());
    const ir = emptyIR("json", text.length);
    try {
      const data: unknown = JSON.parse(text);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        for (const k of Object.keys(data)) ir.outline.push({ id: `k:${k}`, level: 1, title: k, kind: "section" });
      }
      ir.blocks.push({ kind: "code", lang: "json", text: boundText(JSON.stringify(data, null, 2), ctx.limits) });
    } catch {
      ir.meta.degraded = { reason: "invalid JSON — показан сырой текст" };
      ir.blocks.push({ kind: "code", lang: "json", text: boundText(text, ctx.limits) });
    }
    ir.meta.title = source.path;
    return ir;
  },
};
```

- [ ] **Step 4: Реализовать `yaml.ts`** (через `parse` из `yaml`)

```ts
// src/modules/documents/handlers/yaml.ts
import { parse as parseYaml } from "yaml";
import { boundText } from "../bound";
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR } from "../ir";

/** YAML → IR: ключи верхнего уровня — в outline, документ — code-блок. */
export const yamlHandler: DocumentHandler = {
  id: "yaml",
  group: "text",
  extensions: [".yaml", ".yml"],
  detect: (h) => detectHead(h) === "unknown",
  async parse(ctx: ParseContext, source: DocSource) {
    const text = new TextDecoder().decode(await source.bytes());
    const ir = emptyIR("yaml", text.length);
    try {
      const data: unknown = parseYaml(text);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        for (const k of Object.keys(data as Record<string, unknown>)) {
          ir.outline.push({ id: `k:${k}`, level: 1, title: k, kind: "section" });
        }
      }
    } catch {
      ir.meta.degraded = { reason: "invalid YAML — показан сырой текст" };
    }
    ir.blocks.push({ kind: "code", lang: "yaml", text: boundText(text, ctx.limits) });
    ir.meta.title = source.path;
    return ir;
  },
};
```

- [ ] **Step 5: Реализовать `xml.ts` и `html.ts`** (regex-извлечение тегов/заголовков; без внешних деп)

```ts
// src/modules/documents/handlers/xml.ts
import { boundText } from "../bound";
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR } from "../ir";

/** XML/SVG-схема → IR: теги верхнего уровня — в outline, разметка — code-блок. */
export const xmlHandler: DocumentHandler = {
  id: "xml",
  group: "text",
  extensions: [".xml", ".xsd", ".svg", ".plist", ".drawio"],
  detect: (h) => detectHead(h) === "unknown" || detectHead(h) === "svg",
  async parse(ctx: ParseContext, source: DocSource) {
    const text = new TextDecoder().decode(await source.bytes());
    const ir = emptyIR(source.ext.replace(".", "") || "xml", text.length);
    const seen = new Set<string>();
    for (const m of text.matchAll(/<([A-Za-z_][\w.-]*)\b/g)) {
      const tag = m[1];
      if (seen.has(tag)) continue;
      seen.add(tag);
      ir.outline.push({ id: `t:${tag}`, level: 1, title: tag, kind: "section" });
      if (ir.outline.length >= 60) break;
    }
    ir.blocks.push({ kind: "code", lang: "xml", text: boundText(text, ctx.limits) });
    ir.meta.title = source.path;
    return ir;
  },
};
```

```ts
// src/modules/documents/handlers/html.ts
import { boundText } from "../bound";
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR } from "../ir";

/** HTML → IR: <title> и <h1..h6> в outline, текст без тегов — абзацы. */
export const htmlHandler: DocumentHandler = {
  id: "html",
  group: "text",
  extensions: [".html", ".htm"],
  detect: (h) => detectHead(h) === "unknown",
  async parse(ctx: ParseContext, source: DocSource) {
    const text = new TextDecoder().decode(await source.bytes());
    const ir = emptyIR("html", text.length);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.trim();
    if (title) ir.meta.title = title;
    let n = 0;
    for (const m of text.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
      const level = Number(m[1]);
      const t = strip(m[2]).trim();
      if (!t) continue;
      ir.blocks.push({ kind: "heading", level, text: t });
      ir.outline.push({ id: `h${n++}`, level, title: t, kind: "section" });
    }
    const body = strip(text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ""));
    ir.blocks.push({ kind: "paragraph", text: boundText(body.replace(/\s+/g, " ").trim(), ctx.limits) });
    return ir;
  },
};

function strip(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
```

- [ ] **Step 6: Запустить — пройти** — `bun test tests/documents/handlers-text2.test.ts` → PASS.
- [ ] **Step 7: Коммит** `feat(documents): обработчики json/yaml/xml/html (W1)`.

### Task 6: Точка вкл/выкл в коде + реестр

**Files:**
- Create: `src/modules/documents/handlers/index.ts`, `src/modules/documents/registry.ts`
- Test: `tests/documents/toggles.test.ts`, `tests/documents/registry.test.ts`

- [ ] **Step 1: Падающий тест переключателей (INV-D3)**

```ts
// tests/documents/toggles.test.ts
import { describe, expect, it } from "vitest";
import { buildRegistry } from "../../src/modules/documents/registry";
import { csvHandler } from "../../src/modules/documents/handlers/csv";
import { mdHandler } from "../../src/modules/documents/handlers/md";

describe("вкл/выкл в коде", () => {
  it("отключение группы убирает её обработчики", () => {
    const reg = buildRegistry({ enabled: true, groups: ["spreadsheet"], handlers: [csvHandler, mdHandler] });
    expect(reg.active().handlers).toEqual([]);
  });
  it("DOCUMENTS_ENABLED=false — пустой реестр", () => {
    const reg = buildRegistry({ enabled: false, groups: ["text"], handlers: [csvHandler] });
    expect(reg.active().handlers).toEqual([]);
  });
  it("активная группа оставляет обработчик", () => {
    const reg = buildRegistry({ enabled: true, groups: ["text"], handlers: [csvHandler] });
    expect(reg.active().handlers).toEqual(["csv"]);
  });
});
```

- [ ] **Step 2: Запустить — упасть** — FAIL.

- [ ] **Step 3: Реализовать `handlers/index.ts`**

```ts
// src/modules/documents/handlers/index.ts
/** ЕДИНСТВЕННАЯ точка включения/выключения поддержки — в коде, без настроек (INV-D3). */
import type { DocumentHandler, HandlerGroup } from "../handler";
import { csvHandler, tsvHandler } from "./csv";
import { htmlHandler } from "./html";
import { jsonHandler } from "./json";
import { mdHandler } from "./md";
import { xmlHandler } from "./xml";
import { yamlHandler } from "./yaml";

/** Глобальный выключатель всего модуля. */
export const DOCUMENTS_ENABLED = true;

/** Включаемые группы целиком (убрал группу — её обработчики и зависимости выпадают). */
export const ACTIVE_GROUPS: readonly HandlerGroup[] = [
  "text",
  // "spreadsheet", "office", "pdf", "image", "geo",  // → W2–W4
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
  // xlsxHandler, odsHandler, docxHandler, odtHandler, pptxHandler,  // → W2
  // pdfHandler,                                                    // → W3
  // imageHandler, geoHandler,                                      // → W4
];
```

- [ ] **Step 4: Реализовать `registry.ts`**

```ts
// src/modules/documents/registry.ts
import { extname } from "node:path";
import type { Logger } from "../../logger/app-logger";
import { DEFAULT_DOC_LIMITS } from "./bound";
import {
  detectHead,
  type DocSource,
  type DocumentHandler,
  type HandlerGroup,
  type ParseContext,
} from "./handler";
import type { DocumentIR } from "./ir";
import { ACTIVE_GROUPS, DOCUMENTS_ENABLED, HANDLERS } from "./handlers/index";

export interface RegistryOptions {
  enabled?: boolean;
  groups?: readonly HandlerGroup[];
  handlers?: readonly DocumentHandler[];
}

/** Состояние реестра для `health()` (INV-D5: деградация видна). */
export interface RegistryHealth {
  status: "ok" | "degraded";
  reason?: string;
  groups: HandlerGroup[];
  handlers: string[];
}

export interface DocumentRegistry {
  resolve(path: string, head: Uint8Array): DocumentHandler | null;
  parse(ctx: ParseContext, source: DocSource): Promise<DocumentIR>;
  active(): RegistryHealth;
}

/** Собирает реестр из включённых групп/обработчиков (INV-D3). */
export function buildRegistry(opts: RegistryOptions = {}): DocumentRegistry {
  const enabled = opts.enabled ?? DOCUMENTS_ENABLED;
  const groups = opts.groups ?? ACTIVE_GROUPS;
  const all = opts.handlers ?? HANDLERS;
  const active = enabled ? all.filter((h) => groups.includes(h.group)) : [];

  const byExt = new Map<string, DocumentHandler>();
  for (const h of active) for (const e of h.extensions) byExt.set(e.toLowerCase(), h);

  return {
    resolve(path, head) {
      const h = byExt.get(extname(path).toLowerCase());
      if (h?.detect && !h.detect(head)) return null;
      return h ?? null;
    },
    async parse(ctx, source) {
      const head = (await source.bytes()).slice(0, 8);
      const h = this.resolve(source.path, head);
      if (!h) throw new Error(`no handler for ${source.path}`);
      return h.parse(ctx, source);
    },
    active() {
      return { status: "ok", groups: [...groups], handlers: active.map((h) => h.id) };
    },
  };
}

/** Контекст разбора из логера и дефолтных лимитов. */
export function parseCtx(logger: Logger): ParseContext {
  return { logger, limits: DEFAULT_DOC_LIMITS };
}

export { detectHead };
```

- [ ] **Step 5: Падающий тест реестра + затем реализация уже готова**

```ts
// tests/documents/registry.test.ts
import { describe, expect, it } from "vitest";
import { buildRegistry } from "../../src/modules/documents/registry";
import { csvHandler } from "../../src/modules/documents/handlers/csv";
import type { Logger } from "../../src/logger/app-logger";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const ctx = { logger, limits: { maxLines: 100, maxChars: 5000, maxTableRows: 10 } };
const src = (path: string, text: string) => ({ path, ext: path.slice(path.lastIndexOf(".")), bytes: async () => new TextEncoder().encode(text) });

describe("DocumentRegistry", () => {
  it("resolve по расширению", () => {
    const reg = buildRegistry({ enabled: true, groups: ["text"], handlers: [csvHandler] });
    expect(reg.resolve("a.csv", new Uint8Array([0x61]))?.id).toBe("csv");
  });
  it("parse отдаёт DocumentIR", async () => {
    const reg = buildRegistry({ enabled: true, groups: ["text"], handlers: [csvHandler] });
    const ir = await reg.parse(ctx, src("a.csv", "a,b\n1,2"));
    expect(ir.meta.format).toBe("csv");
  });
  it("неизвестный путь — null", () => {
    const reg = buildRegistry({ enabled: true, groups: ["text"], handlers: [csvHandler] });
    expect(reg.resolve("a.bin", new Uint8Array([0x00]))).toBeNull();
  });
});
```

- [ ] **Step 6: Запустить оба — пройти** — `bun test tests/documents/toggles.test.ts tests/documents/registry.test.ts` → PASS.
- [ ] **Step 7: Коммит** `feat(documents): реестр и точка вкл/выкл в коде (W1)`.

### Task 7: Карта документа

**Files:**
- Create: `src/modules/documents/map.ts`
- Test: `tests/documents/map.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
// tests/documents/map.test.ts
import { describe, expect, it } from "vitest";
import { renderDocumentMap } from "../../src/modules/documents/map";
import type { DocumentIR } from "../../src/modules/documents/ir";

const ir: DocumentIR = {
  meta: { format: "md", title: "Doc", bytes: 10 },
  outline: [{ id: "h0", level: 1, title: "A", kind: "section" }, { id: "h1", level: 2, title: "B", kind: "section" }],
  blocks: [{ kind: "heading", level: 1, text: "A" }, { kind: "table", table: { header: ["x"], rows: [["1"]] } }],
};

describe("renderDocumentMap", () => {
  it("перечисляет структуру и счётчики", () => {
    const out = renderDocumentMap(ir);
    expect(out).toContain("A");
    expect(out).toContain("B");
    expect(out).toContain("format: md");
  });
});
```

- [ ] **Step 2: Запустить — упасть** — FAIL.

- [ ] **Step 3: Реализовать**

```ts
// src/modules/documents/map.ts
import type { DocumentIR } from "./ir";

/** Человекочитаемая «карта» документа: мета + оглавление + счётчики (INV-D4). */
export function renderDocumentMap(ir: DocumentIR): string {
  const tables = ir.blocks.filter((b) => b.kind === "table").length;
  const figures = ir.blocks.filter((b) => b.kind === "figure").length;
  const head = [
    `format: ${ir.meta.format}`,
    ir.meta.title ? `title: ${ir.meta.title}` : null,
    ir.meta.pages ? `pages: ${ir.meta.pages}` : null,
    ir.meta.sheets ? `sheets: ${ir.meta.sheets.join(", ")}` : null,
    `blocks: ${ir.blocks.length} · tables: ${tables} · figures: ${figures}`,
    ir.meta.degraded ? `degraded: ${ir.meta.degraded.reason}` : null,
  ].filter(Boolean);
  const outline = ir.outline.map((n) => `${"  ".repeat(Math.max(0, n.level - 1))}- ${n.title}`).join("\n");
  return `${head.join("\n")}\n\n${outline}`.trim();
}
```

- [ ] **Step 4: Запустить — пройти** — `bun test tests/documents/map.test.ts` → PASS.
- [ ] **Step 5: Коммит** `feat(documents): карта документа (W1)`.

### Task 8: Чтение среза по селектору

**Files:**
- Create: `src/modules/documents/read.ts`
- Test: `tests/documents/read.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
// tests/documents/read.test.ts
import { describe, expect, it } from "vitest";
import { parseSelector, renderDocumentRead } from "../../src/modules/documents/read";
import type { DocumentIR } from "../../src/modules/documents/ir";

const ir: DocumentIR = {
  meta: { format: "md", bytes: 10 },
  outline: [],
  blocks: [
    { kind: "heading", level: 1, text: "A" },
    { kind: "paragraph", text: "hello" },
    { kind: "heading", level: 1, text: "B" },
    { kind: "paragraph", text: "world" },
  ],
};

describe("read", () => {
  it("parseSelector разбирает section и blocks", () => {
    expect(parseSelector("section:B")).toEqual({ kind: "section", arg: "B" });
    expect(parseSelector("blocks:2-3")).toEqual({ kind: "blocks", arg: [2, 3] });
    expect(parseSelector("all")).toEqual({ kind: "all" });
    expect(parseSelector("page:3")).toEqual({ kind: "unknown", arg: "page:3" });
  });
  it("section вырезает блоки до следующего заголовка того же уровня", () => {
    const out = renderDocumentRead(ir, { kind: "section", arg: "A" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toContain("hello");
      expect(out.text).not.toContain("world");
    }
  });
  it("отсутствующий раздел — явный отказ со списком доступных", () => {
    expect(renderDocumentRead(ir, { kind: "section", arg: "nope" })).toEqual({
      ok: false,
      kind: "section-not-found",
      arg: "nope",
      available: ["A", "B"],
    });
  });
  it("blocks нумерует блоки", () => {
    const out = renderDocumentRead(ir, { kind: "blocks", arg: [3, 4] });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toContain("world");
      expect(out.text).not.toContain("hello");
    }
  });
});
```

- [ ] **Step 2: Запустить — упасть** — FAIL.

- [ ] **Step 3: Реализовать**

```ts
// src/modules/documents/read.ts
import { boundText, DEFAULT_DOC_LIMITS } from "./bound";
import type { DocBlock, DocumentIR } from "./ir";

export type Selector =
  | { kind: "all" }
  | { kind: "section"; arg: string }
  | { kind: "blocks"; arg: [number, number] }
  | { kind: "unknown"; arg: string };

/** Результат рендера среза: текст либо явная причина отказа (INV-D5). */
export type ReadOutcome =
  | { ok: true; text: string }
  | { ok: false; kind: "section-not-found"; arg: string; available: string[] }
  | { ok: false; kind: "unknown-selector"; arg: string };

/** Разбор строки-селектора: all | section:<title> | blocks:<a>-<b>. */
export function parseSelector(sel: string): Selector {
  const s = (sel || "all").trim();
  if (s === "" || /^all$/i.test(s)) return { kind: "all" };
  const sec = /^section:(.+)$/i.exec(s);
  if (sec) return { kind: "section", arg: sec[1].trim() };
  const bl = /^blocks:(\d+)-(\d+)$/i.exec(s);
  if (bl) return { kind: "blocks", arg: [Number(bl[1]), Number(bl[2])] };
  return { kind: "unknown", arg: s };
}

/** Блок-заголовок раздела с совпадением без учёта регистра; иначе `null`. */
function findSection(ir: DocumentIR, title: string): { start: number; level: number } | null { /* … */ }

/** Текстовый рендер выбранного среза IR (INV-D4): `blocks:` считает блоки, а не строки. */
export function renderDocumentRead(ir: DocumentIR, sel: Selector, limits = DEFAULT_DOC_LIMITS): ReadOutcome {
  // section: нет заголовка → { ok: false, kind: "section-not-found", available: outline titles }
  // (форматы без heading-блоков — csv/json/yaml/xml — тоже дают явный отказ, не весь документ)
  // blocks:<a>-<b> → ir.blocks.slice(a-1, b); all → все блоки; unknown → { ok: false, kind: "unknown-selector" }
  // Успех: { ok: true, text: boundText(...) }
}
```

- [ ] **Step 4: Запустить — пройти** — `bun test tests/documents/read.test.ts` → PASS.
- [ ] **Step 5: Коммит** `feat(documents): чтение среза по селектору (W1)`.

### Task 9: Тулы `document_map` и `document_read`

**Files:**
- Create: `src/modules/documents/tools/document-map.ts`, `src/modules/documents/tools/document-read.ts`, `src/modules/documents/source.ts`
- Test: `tests/documents/tools.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
// tests/documents/tools.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRegistry } from "../../src/modules/documents/registry";
import { csvHandler } from "../../src/modules/documents/handlers/csv";
import { documentMapTool } from "../../src/modules/documents/tools/document-map";
import { documentReadTool } from "../../src/modules/documents/tools/document-read";

const dir = mkdtempSync(join(tmpdir(), "doc-tool-"));
writeFileSync(join(dir, "a.csv"), "a,b\n1,2");
const reg = buildRegistry({ enabled: true, groups: ["text"], handlers: [csvHandler] });
const ctx = { baseDir: dir, logger: { debug() {}, info() {}, warn() {}, error() {} } } as never;

describe("doc tools", () => {
  it("document_map отдаёт карту", async () => {
    const res = await documentMapTool(reg).handler(ctx, { path: "a.csv" });
    expect(res.success).toBe(true);
    expect(res.output).toContain("format: csv");
  });
  it("плохой путь — fail-open с причиной", async () => {
    const res = await documentMapTool(reg).handler(ctx, { path: "nope.csv" });
    expect(res.success).toBe(false);
    expect(String(res.output)).toMatch(/no handler|ENOENT|нет/i);
  });
  it("тулы несут security.fs=read и pathArgs", () => {
    expect(documentMapTool(reg).security.caps).toContainEqual({ fs: "read" });
    expect(documentMapTool(reg).security.pathArgs).toContain("path");
    expect(documentReadTool(reg).security.pathArgs).toContain("path");
  });
});
```

- [ ] **Step 2: Запустить — упасть** — FAIL.

- [ ] **Step 3: Реализовать `source.ts`**

Байты читаются один раз на разбор (промис кэшируется); ошибка `ENOENT`
отображается в дружелюбное сообщение с **относительным** путём (`display`),
без утечки абсолютного (INV-D5).

```ts
// src/modules/documents/source.ts
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { t } from "../../i18n/index";
import type { DocSource } from "./handler";

/** Источник документа по пути относительно baseDir: bytes кэшируются. */
export function fileSource(baseDir: string, raw: string): DocSource {
  const path = resolve(baseDir, raw);
  let cached: Promise<Uint8Array> | undefined;
  const bytes = (): Promise<Uint8Array> => {
    cached ??= readFile(path).catch((err: unknown) => {
      throw new Error(readError(raw, err));
    });
    return cached;
  };
  return { path, display: raw, ext: extname(path).toLowerCase(), bytes };
}
```

- [ ] **Step 4: Реализовать `tools/document-map.ts`**

Общий fail-open раннер `tools/run.ts` (`failOpen`/`failResult`) держит один путь
диагностики для обоих тулов (INV-D5): исключение → запись `module:documents` +
`{success:false}` с причиной.

```ts
// src/modules/documents/tools/document-map.ts
import { t } from "../../../i18n";
import type { ToolDefinition } from "../../../tools/types";
import { parseCtx, type DocumentRegistry } from "../registry";
import { renderDocumentMap } from "../map";
import { fileSource } from "../source";
import { failOpen } from "./run";

/** Тул `document_map`: карта структуры документа (INV-D5 — fail-open с причиной). */
export function documentMapTool(registry: DocumentRegistry): ToolDefinition {
  return {
    name: "document_map",
    security: { caps: [{ fs: "read" }], pathArgs: ["path"] },
    icon: "🗂️",
    tags: ["document", "file"],
    boundedOutput: true,
    cacheable: true,
    description: t("documents.map_desc"),
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: t("documents.path_desc") } },
      required: ["path"],
    },
    handler: (ctx, args) =>
      failOpen(ctx, "document_map", async () => {
        const source = fileSource(ctx.baseDir, String(args.path ?? ""));
        const ir = await registry.parse(parseCtx(ctx.logger), source);
        return renderDocumentMap(ir);
      }),
  };
}
```

- [ ] **Step 5: Реализовать `tools/document-read.ts`**

```ts
// src/modules/documents/tools/document-read.ts
import { t } from "../../../i18n";
import type { ToolDefinition } from "../../../tools/types";
import { parseSelector, renderDocumentRead, type ReadOutcome } from "../read";
import { parseCtx, type DocumentRegistry } from "../registry";
import { fileSource } from "../source";
import { failOpen } from "./run";

/** Отказ рендера (`section` не найден / неизвестный селектор) → причина для модели. */
function failureMessage(outcome: Extract<ReadOutcome, { ok: false }>): string {
  if (outcome.kind === "unknown-selector") return t("documents.selector_unknown", { selector: outcome.arg });
  const available = outcome.available.length ? outcome.available.join(", ") : t("documents.section_none");
  return t("documents.section_not_found", { title: outcome.arg, available });
}

/** Тул `document_read`: срез по селектору (all/section/blocks). */
export function documentReadTool(registry: DocumentRegistry): ToolDefinition {
  return {
    name: "document_read",
    security: { caps: [{ fs: "read" }], pathArgs: ["path"] },
    icon: "📄",
    tags: ["document", "file"],
    boundedOutput: true,
    cacheable: true,
    description: t("documents.read_desc"),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: t("documents.path_desc") },
        selector: { type: "string", description: t("documents.selector_desc") },
      },
      required: ["path"],
    },
    handler: (ctx, args) =>
      failOpen(ctx, "document_read", async () => {
        const selector = parseSelector(String(args.selector ?? "all"));
        const source = fileSource(ctx.baseDir, String(args.path ?? ""));
        const ir = await registry.parse(parseCtx(ctx.logger), source);
        const outcome = renderDocumentRead(ir, selector);
        if (!outcome.ok) throw new Error(failureMessage(outcome));
        return outcome.text;
      }),
  };
}
```

- [ ] **Step 6: Запустить — пройти** — `bun test tests/documents/tools.test.ts` → PASS.
- [ ] **Step 7: Коммит** `feat(documents): тулы document_map/document_read (W1)`.

### Task 10: Регистрация модуля (ModuleDef) и сбор

**Files:**
- Create: `src/modules/documents/module.ts`, `src/modules/documents/index.ts`
- Modify: `src/core/bootstrap/modules-phase.ts`
- Test: `tests/documents/module.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
// tests/documents/module.test.ts
import { describe, expect, it } from "vitest";
import { documentsModuleDef } from "../../src/modules/documents/module";

describe("documentsModuleDef", () => {
  it("не критичен, объявляет два тула, без configKeys", () => {
    const def = documentsModuleDef();
    expect(def.name).toBe("documents");
    expect(def.critical).toBe(false);
    expect(def.tools?.().map((t) => t.name)).toEqual(["document_map", "document_read"]);
    expect(def.configKeys).toBeUndefined();
  });
});
```

- [ ] **Step 2: Запустить — упасть** — FAIL.

- [ ] **Step 3: Реализовать `module.ts`**

```ts
// src/modules/documents/module.ts
import type { ModuleDef } from "../../core/module-host";
import { ACTIVE_GROUPS, DOCUMENTS_ENABLED } from "./handlers/index";
import { buildRegistry } from "./registry";
import { documentMapTool } from "./tools/document-map";
import { documentReadTool } from "./tools/document-read";

/** Определение модуля `documents` (INV-D3/D5/D7): некритичен, без настроек. */
export function documentsModuleDef(): ModuleDef {
  const registry = buildRegistry();
  return {
    name: "documents",
    critical: false,
    requires: [],
    health: () => ({ status: "ok", reason: DOCUMENTS_ENABLED ? undefined : "DOCUMENTS_ENABLED=false" }),
    tools: () => (DOCUMENTS_ENABLED ? [documentMapTool(registry), documentReadTool(registry)] : []),
  };
}

export { ACTIVE_GROUPS, DOCUMENTS_ENABLED };
```

- [ ] **Step 4: Реализовать `index.ts`**

```ts
// src/modules/documents/index.ts
export { documentsModuleDef } from "./module";
export { buildRegistry } from "./registry";
export type { DocumentRegistry, RegistryHealth } from "./registry";
export type { DocumentIR, DocBlock, DocNode, DocTable } from "./ir";
export type { DocumentHandler, HandlerGroup } from "./handler";
```

- [ ] **Step 5: Зарегистрировать в bootstrap**

В `src/core/bootstrap/modules-phase.ts` рядом с `moduleHost.register(indexerModuleDef(...))` добавить:

```ts
import { documentsModuleDef } from "../../modules/documents";
// ...
moduleHost.register(documentsModuleDef());
```

(Точная позиция — в блоке регистрации core-модулей до `await moduleHost.setup()`; тулы
подхватятся через `registerModuleToolsAndPlugins` → `collectTools()`.)

- [ ] **Step 6: Запустить тест модуля**

Run: `bun test tests/documents/module.test.ts`
Expected: PASS.

- [ ] **Step 7: Коммит** `feat(documents): ModuleDef и регистрация в bootstrap (W1)`.

### Task 11: Тег `document` в auto-tags

**Files:**
- Modify: `src/tools/auto-tags.ts:20`
- Test: `tests/documents/auto-tag.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
// tests/documents/auto-tag.test.ts
import { describe, expect, it } from "vitest";
import { KNOWN_TOOL_TAGS, inferExtraToolTags } from "../../src/tools/auto-tags";

describe("document tag", () => {
  it("тег известен", () => {
    expect([...KNOWN_TOOL_TAGS]).toContain("document");
  });
  it("таблица/документ сеет тег document в research-задаче", () => {
    expect(inferExtraToolTags("прочитай таблицу из report.xlsx и summarise")).toContain("document");
  });
});
```

- [ ] **Step 2: Запустить — упасть** — FAIL.

- [ ] **Step 3: Обновить `auto-tags.ts`**

Добавить `"document"` в `KNOWN_TOOL_TAGS` (после `"file"`) и в существующий набор эвристик —
`DOCUMENT_RE = /\.(xlsx|xls|ods|csv|tsv|docx|odt|pptx|pdf|md|markdown|ya?ml|json|xml|html?)\b|таблиц|документ|договор|отчёт|отчет|sheet|spreadsheet|през)/i`,
добавляющий `document` в extra-набор.

- [ ] **Step 4: Запустить — пройти** — `bun test tests/documents/auto-tag.test.ts` → PASS.
- [ ] **Step 5: Коммит** `feat(documents): тег document в auto-tags (W1)`.

### Task 12: i18n и финальные гейты

**Files:**
- Modify: `src/i18n/locales/en.json`, `src/i18n/locales/ru.json`
- Test: `bun test tests/i18n.test.ts`

- [ ] **Step 1: Добавить ключи симметрично (en+ru)**

`documents.map_desc`, `documents.read_desc`, `documents.path_desc`,
`documents.selector_desc`, `documents.error`, `tool.friendly.document_map`,
`tool.friendly.document_read`. Тексты — по [STYLE.md](../design/ui/STYLE.md): кратко, без
системных имён; `documents.error` = «Не удалось прочитать документ: {reason}».

- [ ] **Step 2: Проверить симметрию ключей**

Run: `bun test tests/i18n.test.ts`
Expected: PASS (en/ru симметричны).

- [ ] **Step 3: Полный гейт**

Run: `bun test` → expected: 0 fail.
Run: `bun run quality` → expected: exit 0 (typecheck + typecheck:frontend + check:arch + lint + fallow).

- [ ] **Step 4: Живой прогон (правило 7)**

Run: `bun run mma "сделай карту файла <sandbox>/a.csv и покажи раздел 1" -d <sandbox> -e`
Expected: в `session.jsonl` виден вызов `document_map`/`document_read`; вывод содержит карту.

- [ ] **Step 5: Обновить docs (feature-history/CHANGELOG) и коммит**

```bash
git add src/i18n/locales/en.json src/i18n/locales/ru.json docs/agents/feature-history.md CHANGELOG.md
git commit -m "docs(documents): i18n и запись фичи (W1)"
```

---

# W2–W5 — дорожная карта (детальные планы при старте волны)

Каждая волна — своя ветка от `master` после мержа предыдущей; отдельный план в
`docs/plans/` при старте.

## W2 — Офис и таблицы (`feat/documents-office`)

- `src/modules/documents/handlers/ooxml.ts` — ZIP (`node:zlib` inflate) + `fast-xml-parser`;
  чтение `[Content_Types].xml`/`_rels`, выбор парсера по типу части.
- `handlers/xlsx.ts`, `ods.ts` — листы → `sheets[]` + `DocTable` на лист; outline = листы.
- `handlers/docx.ts`, `odt.ts` — абзацы/заголовки/списки → блоки.
- `handlers/pptx.ts` — слайды → `outline` (kind `slide`) + текстовые блоки.
- Включить группу `"office"`/`"spreadsheet"` в `handlers/index.ts`; обработчики — в `HANDLERS`.
- Тесты: фикстуры-байты (маленькие .xlsx/.docx/.pptx/.ods/.odt) → ожидаемый IR.
- Гейт `bun run quality` зелёный.

## W3 — PDF (`feat/documents-pdf`)

- `handlers/pdf.ts` — `pdfjs-dist` (по результату W0): текст по страницам + outline из
  закладок/эвристики заголовков; нет текстового слоя → `meta.degraded` (fail-open, INV-D5).
- Включить группу `"pdf"`.
- Тесты: текстовый PDF-fixture; скан-подобный (пустой текст) → `degraded`.
- При фолбэке W0 — реализовать чистый TS-экстрактор вместо `pdfjs-dist`.

## W4 — Изображения, графики, карты (`feat/documents-media`)

- `handlers/image.ts` — растровые (png/jpg) → `figure` с `ref.kind="raster"`;
  `document_read` при `ctx.capabilities.vision` возвращает изображение (совместимо с
  `attach_image`), иначе fail-open «нужен vision».
- `handlers/geo.ts` — GeoJSON/GPX/SVG-схемы → IR (парсинг как JSON/XML).
- Включить группы `"image"`/`"geo"`.
- Тесты: image без vision → degraded; GeoJSON → outline по фичам.

## W5 — Индексация корпуса (`feat/documents-index`)

- `src/modules/documents/index.ts` (потребитель) — ленивый индекс каталога: запись
  `{path, mtime, size, outline, chunks}` в `<project>/.mma/documents-cache.json` с
  envelope+signature (по образцу `IndexCache`).
- Тулы `document_index` (`dir`), `document_find` (`path|dir`, `query`); тег `document`.
- Бюджет: ограничение числа чанков/документов; учёт токенов (модуль не должен раздувать
  контекст 9B).
- Тесты: индекс каталога, поиск, обрезка бюджета, fail-open.

---

## Self-Review

- **Spec coverage:** INV-D1 (Task 6), INV-D2 (Tasks 4–9), INV-D3 (Task 6), INV-D4
  (Tasks 3,7,8), INV-D5 (Tasks 9,10), INV-D6 (Task 9), INV-D7 (Tasks 9,10), INV-D8
  (W0.1/W0.2), INV-D9 (структура файлов ≤300). Волны W2–W5 — W2…W5.
- **Placeholders:** W0.2/W0.3 и W2–W5 — это спайк и дорожная карта намеренно (детализация
  при старте волны); W1 (первая исполняемая) — без плейсхолдеров.
- **Type consistency:** `DocumentIR`/`DocBlock`/`DocTable`/`DocumentHandler`/
  `HandlerGroup`/`DocSource`/`ParseContext`/`buildRegistry`/`parseCtx`/`renderDocumentMap`/
  `parseSelector`/`renderDocumentRead` используются согласованно во всех задачах.
