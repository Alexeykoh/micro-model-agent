# Модуль документов — W3: PDF (текстовый слой и оглавление)

> **Статус:** W3 — этот файл. Ветка `feat/documents-pdf` от `master`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Обработчик PDF модуля `documents` на `pdfjs-dist` (legacy build, текстовый слой без
canvas): текст по страницам + оглавление из закладок (`getOutline`) либо эвристика по первой
строке страницы. PDF без текстового слоя (скан) → `meta.degraded` с причиной (INV-D5, без
исключения). Группа `"pdf"` включается в коде (INV-D3).

**Architecture:** `handlers/pdf.ts` — обработчик группы `"pdf"`, **единственный** импортёр
`pdfjs-dist` (INV-D8, гейт `tests/arch/documents-boundaries.test.ts`). Сводит PDF к `DocumentIR`
(`meta.pages`, `outline` `kind:"section"`, блоки `heading`/`paragraph`). Вкл/выкл — в
`handlers/index.ts` (`ACTIVE_GROUPS` + `HANDLERS`, INV-D3). Потребители видят только
`DocumentIR` (INV-D2); текст — через `boundText` (INV-D4).

**Tech Stack:** Bun + TypeScript (strict, NodeNext), vitest через `bun test`;
`pdfjs-dist@6.4.299` (legacy build, inline в бандл по результату W0-спайка).

**Спека:** [2026-10-16-documents-module-design.md](../specs/2026-10-16-documents-module-design.md)
(INV-D2/D3/D4/D5/D6/D8/D9, §4.6 — результаты спайка W0)

**Предшествующая волна:** [2026-10-16-documents-w2-office-plan.md](./2026-10-16-documents-w2-office-plan.md) (W2)

---

## File Structure (W3)

| Файл | Ответственность |
|---|---|
| `src/modules/documents/handlers/pdf.ts` | PDF → `DocumentIR` (группа `pdf`): fake-worker hook, текст по страницам, outline из закладок/эвристики, `meta.pages`, `degraded` без текстового слоя. **Единственный** импорт `pdfjs-dist` (INV-D8) |
| `src/modules/documents/handlers/index.ts` | Включить группу `"pdf"` и `pdfHandler` (modify, INV-D3) |
| `tests/arch/documents-boundaries.test.ts` | INV-D8: `pdfjs-dist` импортируется только из `handlers/pdf.ts` (modify, INV-D8) |
| `tests/documents/fixtures-pdf.ts` | Детерминированный минимальный PDF-строитель (1 и N страниц, no-text) |
| `tests/documents/handlers-pdf.test.ts` | `helloPdf` → формат/страницы/текст/outline; no-text → `degraded`; multipage; detect/registry |

Порядок: фикстуры (Task 1) до обработчика (Task 2); гейт INV-D8 (Task 3) красный до `pdf.ts`
и зелёный после.

---

### Task 0: План волны

**Files:**
- Create: `docs/plans/2026-10-16-documents-w3-pdf-plan.md`

- [ ] **Step 1:** Зафиксировать план W3 (этот файл) и закоммитить первым.
- [ ] **Step 2: Коммит** `docs(documents): план W3 — PDF (W3)`.

### Task 1: Детерминированные PDF-фикстуры

**Files:**
- Create: `tests/documents/fixtures-pdf.ts`

- [ ] **Step 1:** Строитель минимального валидного PDF: `%PDF-1.4`, объекты
  (Catalog/Pages/Page/Content/Font), `xref`, `trailer`, `%%EOF`. Расширяемый до N страниц с
  заданным текстом на страницу; пустой content stream → нет текстового слоя.
- [ ] **Step 2:** Экспорты: `buildPdf(pages)`, `helloPdf()`, `noTextPdf()`,
  `multiPagePdf(texts)`.
- [ ] **Step 3: Коммит** `test(documents): фикстуры PDF (W3)`.

### Task 2: Обработчик PDF

**Files:**
- Create: `src/modules/documents/handlers/pdf.ts`
- Test: `tests/documents/handlers-pdf.test.ts`

- [ ] **Step 1:** Падающий тест: `helloPdf` → `meta.format==="pdf"`, `meta.pages===1`, текст
  содержит "Hello", outline непуст; no-text → `degraded`; multipage; `detect` по `%PDF-`.
- [ ] **Step 2:** Запустить — упасть: `bun test tests/documents/handlers-pdf.test.ts`.
- [ ] **Step 3:** Реализовать `pdfHandler`: fake-worker hook
  (`globalThis.pdfjsWorker = { WorkerMessageHandler }`) до первого использования pdfjs;
  `getDocument({data}).promise`; `meta.pages = doc.numPages`; `getOutline()` → outline
  (`kind:"section"`, уровень из вложенности), иначе эвристика «первая непустая строка страницы
  → heading + outline, остаток → paragraph»; нет текста → `degraded`; `task.destroy()` в
  `finally`; текст через `boundText`. Малоформированный PDF — исключение наружу (fail-open
  тула, INV-D5), валидный без текста — `degraded`.
- [ ] **Step 4:** Запустить — пройти.
- [ ] **Step 5: Коммит** `feat(documents): обработчик PDF (W3)`.

### Task 3: Гейт изоляции зависимости (INV-D8) + вкл/выкл

**Files:**
- Modify: `tests/arch/documents-boundaries.test.ts`
- Modify: `src/modules/documents/handlers/index.ts`
- Test: `tests/documents/registry.test.ts` (дополнить)

- [ ] **Step 1:** Расширить INV-D8: `pdfjs-dist` импортируется только из `handlers/pdf.ts`
  (наравне с `fast-xml-parser` в `handlers/ooxml.ts`); добавить юнит-кейс на игнор в
  комментарии.
- [ ] **Step 2:** В `ACTIVE_GROUPS` добавить `"pdf"`, в `HANDLERS` — `pdfHandler` (снять
  placeholder `// pdfHandler // → W3`; `image/geo` оставить закомментированными).
- [ ] **Step 3:** Кейс реестра: `.pdf` с `%PDF-`-magic резолвится в `pdf`.
- [ ] **Step 4:** Запустить — пройти: `bun test tests/documents tests/arch`.
- [ ] **Step 5: Коммит** `feat(documents): гейт INV-D8 + включаю pdf в реестре (W3)`.

### Task 4: Полная проверка

- [ ] **Step 1:** `bun test tests/documents tests/arch` → зелёный (report real numbers).
- [ ] **Step 2:** `bun run quality` → exit 0.
- [ ] **Step 3:** `bun run build:documents` → exit 0; inline-check называет и
  `fast-xml-parser`, и `pdfjs-dist`.
- [ ] **Step 4:** Все файлы `src/` ≤300 строк; нет `as any`/`as unknown as`.

---

## Self-Review

- **INV coverage:** INV-D2 (обработчик под `handlers/`, потребители не менялись),
  INV-D3 (`"pdf"` + `pdfHandler` в `index.ts`), INV-D4 (`boundText` на блоки),
  INV-D5 (`degraded` с причиной на no-text; битый PDF — исключение → fail-open тула),
  INV-D6 (политику не реализует), INV-D8 (`pdfjs-dist` — единственный импортёр `pdf.ts`),
  INV-D9 (файл ≤300 строк).
- **Решения:**
  - Fake-worker: `globalThis.pdfjsWorker = { WorkerMessageHandler }` из
    `pdfjs-dist/legacy/build/pdf.worker.mjs` (W0-спайк) — иначе pdfjs динамически тянет
    `pdf.worker.mjs` рядом с бандлом.
  - У `pdf.worker.mjs` нет `.d.mts` — строку импорта сопровождает `@ts-expect-error` с
    обоснованием (не `as any`).
  - `destroy()` берётся у `PDFDocumentLoadingTask` (`getDocument(...)`), а не у
    `PDFDocumentProxy` — в типах v6 `destroy` есть только у loading task.
- **Known limitations:**
  - Эвристика оглавления: при отсутствии закладок «заголовок» страницы — первая непустая
    строка; это приближение, не структура документа.
  - Сканы/изображения в PDF (нет текстового слоя) честно деградируют, без OCR.
  - Колонтитулы/порядок текстовых ранов определяется `pdfjs-dist` (его `hasEOL`).

---

## Review follow-ups (2026-10-16)

Правки по ревью W3 (ветка `feat/documents-pdf`):

- **INV-D4 — границы заголовков (модульно).** `boundLine(text, limits)` в `bound.ts`:
  однострочный текст обрезается до `maxChars` с маркером; короткие строки не
  меняются. Применён к `text` блоков `heading` и к `title` узлов `outline` в
  `md.ts`, `docx.ts`, `odt.ts`, `html.ts`, `pdf.ts` (в PDF — и эвристика по первой
  строке, и `pushOutline`). `meta.title` оставлен сырым (вне объёма правки).
- **INV-D4/D5 — границы страниц PDF.** Накопитель `total` заменён булевым
  `hasText`; обход страниц ограничен `MAX_PAGES = 200`. При превышении разбираются
  первые `MAX_PAGES`, `meta.pages` остаётся истинным, а `meta.degraded` честно
  сообщает «показаны первые N страниц» (INV-D5).
- **Комментарии в `pdf.ts`.** Задокументированы принятый нефатальный warning
  `standardFontDataUrl` (влияет на глифы, не на текст) и ленивое чтение
  `globalThis.pdfjsWorker` внутри `getDocument` (хук fake-worker).
- **Фикстуры/тесты.** Дерево `/Outlines` (`outlinePdf`) + тест `pushOutline`
  (titles/levels); тест cap-страниц; тест битого PDF (`parse` бросает); тесты
  границ огромных заголовков (`bound`/md/html). Заголовок `fixtures-pdf.ts`
  сужен: побайтово точны только смещения `xref`, `/Length` — по числу символов.
