# Модуль документов — W2a: ZIP/OOXML-слой и XLSX

> **Статус:** исполнено (2026-10-20) — W2a (ZIP/OOXML/XLSX) и W2b (ODF/office) реализованы
> в master; гейт `tests/arch/documents-boundaries.test.ts` зелёный. Чекбоксы проставлены по факту.

> спецификация волны в самом низу этого файла, § «W2b».

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use

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

- [x] **Step 1:** Зафиксировать план W2a (этот файл) и закоммитить первым.
- [x] **Step 2: Коммит** `docs(documents): план W2a — ZIP/OOXML и xlsx (W2)`.

### Task 1: Гейт границ — импорты внутри `handlers/`

**Files:**
- Modify: `tests/arch/documents-boundaries.test.ts`

W2 нужны общие модули **внутри** `handlers/` (`ooxml.ts`, `zip.ts`), импортируемые
соседями. Гейт INV-D2 сужаем: импорт `handlers/*` разрешён только когда импортёр сам
лежит под `src/modules/documents/handlers/`, плюс `registry.ts`. Потребители
(`read.ts`, `tools/*`, `module.ts`, …) по-прежнему не имеют права импортировать обработчики.

- [x] **Step 1:** Дописать падающий кейс: `handlers/xlsx.ts` импортирует `./ooxml` → не флаг.
- [x] **Step 2:** Запустить — упасть: `bun test tests/arch/documents-boundaries.test.ts`.
- [x] **Step 3:** Дополнить `findDocumentHandlerImports`: `if (from.startsWith(HANDLERS_PREFIX)) continue;`; обновить doc-комментарий.
- [x] **Step 4:** Запустить — пройти.
- [x] **Step 5: Коммит** `test(documents): гейт разрешает импорты внутри handlers/ (W2)`.

### Task 5: Детерминированные фикстуры ZIP/XLSX

**Files:**
- Create: `tests/documents/fixtures-zip.ts`, `tests/documents/fixtures-xlsx.ts`

- [x] **Step 1:** `fixtures-zip.ts` — ZIP-писатель: local header + central directory + EOCD;
  метод 0 и 8 (`zlib.deflateRawSync`); локальный `crc32` (значение не читается нашим
  ридером, но writer держим spec-shaped).
- [x] **Step 2:** `fixtures-xlsx.ts` — минимальная книга: `[Content_Types].xml`, `_rels/.rels`,
  `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/sharedStrings.xml`,
  `xl/worksheets/sheet1.xml`. Малые и детерминированные байты.
- [x] **Step 3: Коммит** `test(documents): фикстуры ZIP/XLSX (W2)`.

### Task 2: ZIP-читатель

**Files:**
- Create: `src/modules/documents/handlers/zip.ts`
- Test: `tests/documents/zip.test.ts`

- [x] **Step 1:** Падающий тест: собрать ZIP-фикстуру (stored + deflate), проверить
  извлечение записей и `readZipText`.
- [x] **Step 2:** Запустить — упасть: `bun test tests/documents/zip.test.ts`.
- [x] **Step 3:** Реализовать `readZip`/`readZipText` (EOCD, центральный каталог, local
  header, методы 0/8, ясная `Error` на битый ввод).
- [x] **Step 4:** Запустить — пройти.
- [x] **Step 5: Коммит** `feat(documents): ZIP-читатель zip.ts (W2)`.

### Task 3: OOXML-слой

**Files:**
- Create: `src/modules/documents/handlers/ooxml.ts`

- [x] **Step 1:** `parseXml` (`ignoreAttributes:false`, `@_`-префикс, значения тегов —
  строки), `asArray`, `attr`, `textOf`, `collectText`, `readOoxml(bytes)`.
  **Единственный** импорт `fast-xml-parser` (INV-D8).
- [x] **Step 2: Коммит** `feat(documents): OOXML-хелперы ooxml.ts (W2)`.

### Task 4: Обработчик XLSX

**Files:**
- Create: `src/modules/documents/handlers/xlsx.ts`
- Test: `tests/documents/handlers-xlsx.test.ts`

- [x] **Step 1:** Падающий тест на XLSX-фикстуре: `meta.sheets`, заголовок/строки, `kind:"sheet"`
  в outline, `truncated` при превышении `maxTableRows`.
- [x] **Step 2:** Запустить — упасть: `bun test tests/documents/handlers-xlsx.test.ts`.
- [x] **Step 3:** Реализовать: имена/порядок листов из `xl/workbook.xml`, rId→target через
  `xl/_rels/workbook.xml.rels` (фолбэк — `sheet{N}.xml`); shared strings; ячейки (`@_r` →
  колонка, `t="s"` → shared-string, `inlineStr`/`str` → литерал); прямоугольные строки.
  Нет worksheet-частей → `meta.degraded` (INV-D5), без исключения.
- [x] **Step 4:** Запустить — пройти.
- [x] **Step 5: Коммит** `feat(documents): обработчик XLSX (W2)`.

### Task 6: Вкл/выкл и реестр

**Files:**
- Modify: `src/modules/documents/handlers/index.ts`
- Test: `tests/documents/registry.test.ts` (дополнить)

- [x] **Step 1:** Падающий кейс: `.xlsx` c ZIP-magic резолвится в `xlsx`.
- [x] **Step 2:** Запустить — упасть.
- [x] **Step 3:** В `ACTIVE_GROUPS` добавить `"spreadsheet"`, в `HANDLERS` — `xlsxHandler`
  (снять только соответствующие placeholder-строки `// → W2`).
- [x] **Step 4:** Запустить — пройти: `bun test tests/documents`.
- [x] **Step 5: Коммит** `feat(documents): включаю spreadsheet/xlsx в реестре (W2)`.

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

---

# W2b — ODF и остальные офисные форматы (ods/docx/odt/pptx)

**Goal:** Второй набор офисных обработчиков поверх уже готового ZIP/OOXML-слоя W2a:
ODF (ods/odt) и OOXML Word/PowerPoint (docx/pptx). XML-разбор во всех — через
`ooxml.ts` (INV-D8); таблицы/текст — через `boundTable`/`boundText` (INV-D4);
пустой/неразбираемый ввод → `meta.degraded` (INV-D5), без исключения.

**Спека:** та же ([2026-10-16-documents-module-design.md](../specs/2026-10-16-documents-module-design.md)).

## File Structure (W2b)

| Файл | Ответственность |
|---|---|
| `src/modules/documents/handlers/odf.ts` | ODF-слой: чтение `content.xml`, `odfBody`, `odfText`/`odfHeadingLevel`/`odfListItems`, `readOdfTable` (повторы строк/колонок, cap) |
| `src/modules/documents/handlers/ods.ts` | ODS → `DocumentIR`: `table:table` → листы (outline `sheet` + блок-таблица), `meta.sheets` |
| `src/modules/documents/handlers/docx.ts` | DOCX/DOCM → `DocumentIR`: `w:pStyle` (Heading N) → heading+outline; `w:numPr` → list; `w:tbl` → таблица; первый `Heading1` → `meta.title` |
| `src/modules/documents/handlers/odt.ts` | ODT/FODT → `DocumentIR`: `text:h`/`text:p`/`text:list`/`table:table` |
| `src/modules/documents/handlers/pptx.ts` | PPTX → `DocumentIR`: слайды `ppt/slides/slide{N}.xml` → outline `slide` + paragraph, `meta.pages` |
| `src/modules/documents/handlers/ooxml.ts` | +`child`/`findAll` — общие навигаторы по дереву парсера (modify, W2b) |
| `src/modules/documents/handlers/index.ts` | Включить группу `"office"` и `odsHandler`/`docxHandler`/`odtHandler`/`pptxHandler` (modify, INV-D3) |
| `tests/documents/fixtures-odf.ts` | Минимальные пакеты ODS/ODT (`content.xml`) |
| `tests/documents/fixtures-office.ts` | Минимальные пакеты DOCX (`word/document.xml`) и PPTX (`ppt/slides/slide1.xml`) |
| `tests/documents/handlers-ods.test.ts` | ODS: заголовок/строки, повторы, truncated, degraded |
| `tests/documents/handlers-office.test.ts` | DOCX (заголовки/список/таблица/degraded), ODT, PPTX (слайды/degraded) |

## Tasks (W2b)

- **Task W2b.1:** `odf.ts` + общие `child`/`findAll` в `ooxml.ts`.
- **Task W2b.2:** `ods.ts` (группа spreadsheet).
- **Task W2b.3:** `docx.ts` (группа office).
- **Task W2b.4:** `odt.ts` (группа office).
- **Task W2b.5:** `pptx.ts` (группа office).
- **Task W2b.6:** вкл/выкл — `"office"` в `ACTIVE_GROUPS`, четыре обработчика в `HANDLERS`;
  кейс реестра на `.ods/.docx/.odt/.pptx` (ZIP-magic) и `"office"` в списке групп.
- **Task W2b.7:** фикстуры ODF/Office + тесты обработчиков; degraded-кейс на каждый формат.

## Self-Review (W2b)

- **INV coverage:** INV-D2 (все обработчики — под `handlers/`), INV-D4 (`boundTable`/`boundText`,
  cap повторов в `readOdfTable`/`readTable`), INV-D5 (degraded на отсутствие части/пустоту),
  INV-D6 (политику не реализуют), INV-D8 (`odf.ts` и обработчики берут XML только из
  `ooxml.ts`; `fast-xml-parser` — единственный импортёр `ooxml.ts`), INV-D9 (все файлы ≤300 строк).
- **Known limitations:**
  - docx/odt: `ordered:false` — нумерация docx в `numbering.xml`, у ODF списков — стилем;
    определять «нумерованный/маркированный» по элементу нельзя (осознанно вне объёма).
  - docx/odt: **порядок блоков между разными тегами не сохраняется.** Парсер группирует
    одноимённых детей под ключом, поэтому блоки идут по первому появлению тега
    (`h p h p` → `h h p p`), а внутри одной серии одного типа порядок сохраняется.
    Для типовых документов достаточно; альтернатива — `preserveOrder` у `fast-xml-parser`
    (полный обход с сохранением исходного порядка) — осознанно **не** внедрена в W2b.
  - ODF: `table:covered-table-cell` (объединённые ячейки) и `office:annotation` не разворачиваются.
  - pptx: текст — только `p:sp/p:txBody`; фигуры диаграмм/групп/заметок не читаются.
