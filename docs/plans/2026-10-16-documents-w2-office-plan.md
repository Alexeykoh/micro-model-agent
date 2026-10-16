# Модуль документов — W2a: ZIP/OOXML-слой и XLSX

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Первый офисный обработчик модуля `documents` — XLSX — на собственном минимальном
ZIP-читателе (`node:zlib`) и общем OOXML-слое (`fast-xml-parser`). Волна W2a ограничена
таблицами (xlsx/xlsm); ods/docx/odt/pptx — последующие волны W2.

**Architecture:** Общий слой `handlers/zip.ts` (ZIP-чтение без зависимостей) и
`handlers/ooxml.ts` (разбор XML поверх `zip.ts`; **единственный** импортёр
`fast-xml-parser`, INV-D8). `handlers/xlsx.ts` — обработчик группы `spreadsheet`, сводит
листы книги к `DocumentIR` (outline = листы, блок-таблица на лист). Вкл/выкл — в
`handlers/index.ts` (`ACTIVE_GROUPS` + `HANDLERS`, INV-D3).

**Tech Stack:** Bun + TypeScript (strict, NodeNext), vitest через `bun test`; `node:zlib`,
`fast-xml-parser@5.11.2`.

**Спека:** [2026-10-16-documents-module-design.md](../specs/2026-10-16-documents-module-design.md)
(INV-D2/D3/D5/D6/D8/D9)

**Предшествующая волна:** [2026-10-16-documents-module-plan.md](./2026-10-16-documents-module-plan.md) (W0+W1)

---

## File Structure (W2a)

| Файл | Ответственность |
|---|---|
| `src/modules/documents/handlers/zip.ts` | Минимальный ZIP-читатель (`node:zlib`): EOCD → центральный каталог → local headers; методы 0 (stored) и 8 (deflate) |
| `src/modules/documents/handlers/ooxml.ts` | OOXML-хелперы: `parseXml`, `asArray`, `attr`, `textOf`, `collectText`, `readOoxml`; **единственный** импорт `fast-xml-parser` (INV-D8) |
| `src/modules/documents/handlers/xlsx.ts` | XLSX/XLSM → `DocumentIR`: листы → outline (`kind:"sheet"`) + блок-таблица на лист |
| `src/modules/documents/handlers/index.ts` | Включить группу `"spreadsheet"` и `xlsxHandler` (modify, INV-D3) |
| `tests/arch/documents-boundaries.test.ts` | Разрешить импорты внутри `handlers/` (modify, INV-D2) |
| `tests/documents/fixtures-zip.ts` | Детерминированный ZIP-писатель (helper) |
| `tests/documents/fixtures-xlsx.ts` | Минимальная валидная книга XLSX (helper) |
| `tests/documents/zip.test.ts` | Чтение stored/deflated записей |
| `tests/documents/handlers-xlsx.test.ts` | Листы, заголовок/строки, outline, truncated |

Порядок важен: фикстуры (Task 5) идут до тестов zip/xlsx — те зависят от них.

---

### Task 0: План волны

**Files:**
- Create: `docs/plans/2026-10-16-documents-w2-office-plan.md`

- [ ] **Step 1:** Зафиксировать план W2a (этот файл) и закоммитить первым.
- [ ] **Step 2: Коммит** `docs(documents): план W2a — ZIP/OOXML и xlsx (W2)`.

### Task 1: Гейт границ — импорты внутри `handlers/`

**Files:**
- Modify: `tests/arch/documents-boundaries.test.ts`

W2 нужны общие модули **внутри** `handlers/` (`ooxml.ts`, `zip.ts`), импортируемые
соседями. Гейт INV-D2 сужаем: импорт `handlers/*` разрешён только когда импортёр сам
лежит под `src/modules/documents/handlers/`, плюс `registry.ts`. Потребители
(`read.ts`, `tools/*`, `module.ts`, …) по-прежнему не имеют права импортировать обработчики.

- [ ] **Step 1:** Дописать падающий кейс: `handlers/xlsx.ts` импортирует `./ooxml` → не флаг.
- [ ] **Step 2:** Запустить — упасть: `bun test tests/arch/documents-boundaries.test.ts`.
- [ ] **Step 3:** Дополнить `findDocumentHandlerImports`: `if (from.startsWith(HANDLERS_PREFIX)) continue;`; обновить doc-комментарий.
- [ ] **Step 4:** Запустить — пройти.
- [ ] **Step 5: Коммит** `test(documents): гейт разрешает импорты внутри handlers/ (W2)`.

### Task 5: Детерминированные фикстуры ZIP/XLSX

**Files:**
- Create: `tests/documents/fixtures-zip.ts`, `tests/documents/fixtures-xlsx.ts`

- [ ] **Step 1:** `fixtures-zip.ts` — ZIP-писатель: local header + central directory + EOCD;
  метод 0 и 8 (`zlib.deflateRawSync`); локальный `crc32` (значение не читается нашим
  ридером, но writer держим spec-shaped).
- [ ] **Step 2:** `fixtures-xlsx.ts` — минимальная книга: `[Content_Types].xml`, `_rels/.rels`,
  `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/sharedStrings.xml`,
  `xl/worksheets/sheet1.xml`. Малые и детерминированные байты.
- [ ] **Step 3: Коммит** `test(documents): фикстуры ZIP/XLSX (W2)`.

### Task 2: ZIP-читатель

**Files:**
- Create: `src/modules/documents/handlers/zip.ts`
- Test: `tests/documents/zip.test.ts`

- [ ] **Step 1:** Падающий тест: собрать ZIP-фикстуру (stored + deflate), проверить
  извлечение записей и `readZipText`.
- [ ] **Step 2:** Запустить — упасть: `bun test tests/documents/zip.test.ts`.
- [ ] **Step 3:** Реализовать `readZip`/`readZipText` (EOCD, центральный каталог, local
  header, методы 0/8, ясная `Error` на битый ввод).
- [ ] **Step 4:** Запустить — пройти.
- [ ] **Step 5: Коммит** `feat(documents): ZIP-читатель zip.ts (W2)`.

### Task 3: OOXML-слой

**Files:**
- Create: `src/modules/documents/handlers/ooxml.ts`

- [ ] **Step 1:** `parseXml` (`ignoreAttributes:false`, `@_`-префикс, значения тегов —
  строки), `asArray`, `attr`, `textOf`, `collectText`, `readOoxml(bytes)`.
  **Единственный** импорт `fast-xml-parser` (INV-D8).
- [ ] **Step 2: Коммит** `feat(documents): OOXML-хелперы ooxml.ts (W2)`.

### Task 4: Обработчик XLSX

**Files:**
- Create: `src/modules/documents/handlers/xlsx.ts`
- Test: `tests/documents/handlers-xlsx.test.ts`

- [ ] **Step 1:** Падающий тест на XLSX-фикстуре: `meta.sheets`, заголовок/строки, `kind:"sheet"`
  в outline, `truncated` при превышении `maxTableRows`.
- [ ] **Step 2:** Запустить — упасть: `bun test tests/documents/handlers-xlsx.test.ts`.
- [ ] **Step 3:** Реализовать: имена/порядок листов из `xl/workbook.xml`, rId→target через
  `xl/_rels/workbook.xml.rels` (фолбэк — `sheet{N}.xml`); shared strings; ячейки (`@_r` →
  колонка, `t="s"` → shared-string, `inlineStr`/`str` → литерал); прямоугольные строки.
  Нет worksheet-частей → `meta.degraded` (INV-D5), без исключения.
- [ ] **Step 4:** Запустить — пройти.
- [ ] **Step 5: Коммит** `feat(documents): обработчик XLSX (W2)`.

### Task 6: Вкл/выкл и реестр

**Files:**
- Modify: `src/modules/documents/handlers/index.ts`
- Test: `tests/documents/registry.test.ts` (дополнить)

- [ ] **Step 1:** Падающий кейс: `.xlsx` c ZIP-magic резолвится в `xlsx`.
- [ ] **Step 2:** Запустить — упасть.
- [ ] **Step 3:** В `ACTIVE_GROUPS` добавить `"spreadsheet"`, в `HANDLERS` — `xlsxHandler`
  (снять только соответствующие placeholder-строки `// → W2`).
- [ ] **Step 4:** Запустить — пройти: `bun test tests/documents`.
- [ ] **Step 5: Коммит** `feat(documents): включаю spreadsheet/xlsx в реестре (W2)`.

---

## Self-Review

- **INV coverage:** INV-D2 (Task 1), INV-D3 (Task 6), INV-D5 (Task 4, degraded-ветка),
  INV-D6 (обработчики политику не реализуют), INV-D8 (Task 3 — единственный импорт
  `fast-xml-parser`), INV-D9 (каждый файл ≤300 строк).
- **Deviations:** `parseXml` дополнительно ставит `parseTagValue:false` — значения тегов
  остаются строками, чтобы не терять ведущие нули и точность чисел в ячейках (в брифе
  перечислены четыре опции; пятая — обоснованное расширение).
- **Known fallbacks:** rId→target фолбэк на `sheet{N}.xml`; порядок `<si>`-ранов — по
  порядку ключей объекта парсера (смешанный `<t>+<r>` редок); CRC и zip64 не проверяются.
