# Модуль документов — единый субстрат чтения, карты и индексации

_Дата: 2026-10-16. Ветка: `feat/documents-module`. Статус: target (нормативный документ)._

_Развилка выбрана в брейншторме: подход **A** — реестр обработчиков + нормализованное
представление (`DocumentIR`), вкл/выкл в коде, зависимости вшиты в билд. Запрос покрывает
таблицы, офисные документы, PDF (текст и сканы), графики/диаграммы, карты, источники
данных-чартов и текстовые/разметочные форматы._

---

## 1. Задача

Дать агенту поддержку «рабочих документов»: **карта** (структура/оглавление документа),
**индексация**, **парсинг** и **чтение** — для таблиц (XLSX/CSV/TSV/ODS), офисных
(DOCX/ODT/PPTX), PDF, графиков/диаграмм (PNG/JPG/SVG), карт (гео/схемы) и источников
данных, на которых построены графики, поверх уже частично поддержанных текстовых форматов
(MD/HTML/TXT/JSON/YAML/XML).

Требования:

- **Расширяемость** — новый формат = один файл-обработчик + одна строка в реестре.
- **Масштабируемость** — обработчики форматов изолированы и не влияют на потребителей.
- **Вкл/выкл в коде, без настроек** — включение и выключение поддержки делается правкой
  кода (массив/константа), не ключом конфига.
- **Стандарт architecture v2** — новый код живёт в модуле (`ModuleDef`), видит ядро только
  через `src/core/api/**`, проходит гейты `tests/arch/*`.

---

## 2. Что не так сейчас (текущее состояние, с адресами)

1. **Единого понятия «документ» нет.** Обработка контента размазана по независимым
   подсистемам без общего реестра:
   - индексатор — только текст/код, ~40 расширений; неизвестное расширение пропускается
     наглухо (`src/modules/indexer/walker.ts:315`, `src/modules/indexer/symbols.ts:268`);
   - память — плоский `.md` (`src/modules/memory/store.ts`);
   - `scan_corpus`/`chunk_query` — только UTF-8 (`src/tools/scan-corpus.ts:86`,
     `src/tools/chunk-query.ts`);
   - `attach_image` — картинки в vision (`src/tools/attach-image.ts`).
2. **Нет парсинга PDF/XLSX/DOCX.** Единственный признак формата — MIME для рендера
   браузером (`src/modules/webui/file/file-api.ts:68`, `.pdf → application/pdf`), а не
   извлечение содержимого.
3. **Нет единого реестра форматов/расширений.** Шесть разрозненных switch-ей:
   `src/llm/image-utils.ts:5` (`MIME_MAP`), `src/modules/webui/file/file-api.ts:68`
   (`mimeForView`), `src/modules/session/image-store.ts`, `src/core/agent/artifact-resolve.ts:24`,
   `src/tools/syntax-validator.ts:314`, `src/modules/execution/verifier.ts:299`.
4. **Нет «карты документа» и индексного поиска по документам.** Карта есть только у кода
   (`project_map`), и она идёт в системный промпт.
5. **Потребители не отделены от форматов.** Любой парсинг пришлось бы делать в каждом
   туле отдельно.

---

## 3. Нормативный контракт (инварианты)

**INV-D1. Один реестр форматов.** Соответствие «файл → обработчик» определяется **только**
`DocumentRegistry`. Новые scattered-switch'и по расширению/MIME в модуле запрещены; существующие
в ядре не расширяются (задел на будущее сведение — долг, см. §8).

**INV-D2. Потребители зависят только от `DocumentIR`.** `document_map` / `document_read` /
индексация не знают ни одного конкретного формата. Формат-специфика живёт исключительно в
обработчике. Внутри `handlers/` обработчики вправе импортировать друг друга и общие слои
(ZIP/OOXML) — это один слой модуля. Извне `handlers/` конкретный обработчик импортируется
**только** из `registry.ts` (точка сборки реестра). Проверяется:
`tests/arch/documents-boundaries.test.ts`.

**INV-D3. Вкл/выкл — в коде, без конфига.** Единственная точка переключения —
`src/modules/documents/handlers/index.ts` (`ACTIVE_GROUPS` + `HANDLERS`) и глобальная
константа `DOCUMENTS_ENABLED`. Модуль **не объявляет** `configKeys()`. Проверяется:
`tests/documents/toggles.test.ts` (исключение группы снимает её обработчики из реестра).

**INV-D4. Ограниченный вывод.** Любой результат тула ограничен по строкам/токенам;
табличная выдача несёт флаг `truncated`. Потребители обязаны проходить через общий
`bound(...)`-хелпер, а не собирать строки произвольно.

**INV-D5. Fail-open только с записью.** Неподдерживаемый / битый / пустой документ и любая
деградация (PDF без текстового слоя, растровый график без vision) дают результат с
`cause` **и** запись `module:documents` в `session.jsonl` (INV-12/15). «Пустой успех»
запрещён.

**INV-D6. Enforcement — не в модуле.** Обработчики и тулы объявляют `security`
(`fs:read`, `pathArgs`); scope/protected-path/SSRF применяет `ToolExecutor.execute()`.
Хендлер политику не реализует и security-примитивы не импортирует (INV-9/10).

**INV-D7. Границы модуля.** Модуль импортирует только `src/core/api/**`, не тянет
`core/agent/*` и не вызывает чужие `tool.handler` (INV-3/4; гвард
`tests/arch/module-boundaries.test.ts`).

**INV-D8. Изоляция зависимости по обработчику.** Тяжёлая зависимость формата импортируется
**только** своим обработчиком. Отключение группы/обработчика в коде исключает её из бандла.
Проверяется: сборка без отключённых групп включает ровно ожидаемый набор чанков (см. §4.6).

**INV-D9. Размер файлов.** Каждый файл ≤300 строк; превышение — отдельная запись в
`.arch-allowlist.json` с причиной и датой (правило 6).

---

## 4. Архитектура

### 4.1 Границы

Критерий «ядро/модуль»: документные форматы **отключаемы** → модуль.

```
src/modules/documents/
  ir.ts           # DocumentIR + типы блоков и таблиц
  handler.ts      # DocumentHandler, HandlerGroup, ParseContext, DocSource
  registry.ts     # DocumentRegistry: resolve/detect/parse (+ кэш по mtime/size)
  bound.ts        # ограничение вывода/токенов (общий для потребителей)
  handlers/
    index.ts      # ЕДИНСТВЕННАЯ точка вкл/выкл в коде
    csv.ts ts.ts md.ts json.ts html.ts xml.ts yaml.ts   # текстовое семейство
    ooxml.ts odf.ts                                     # общий ZIP+XML слой
    xlsx.ts docx.ts pptx.ts ods.ts odt.ts               # офис/таблицы
    pdf.ts                                              # PDF (текстовый слой)
    image.ts                                            # растровые графики/карты → vision
    geo.ts                                              # GeoJSON/GPX/SVG-схемы
  tools/
    document-map.ts  document-read.ts                   # W1
    document-index.ts document-find.ts                  # W5
  read.ts map.ts index.ts        # потребители, только DocumentIR
  module.ts       # тонкая сборка объекта модуля
  lifecycle.ts    # documentsModuleDef(...) — ModuleDef
  index.ts        # публичный экспорт модуля
```

Изменения в ядре — **только аддитивные**:
- регистрация модуля в `src/core/bootstrap/modules-phase.ts` (по образцу `indexerModuleDef`);
- при необходимости — тег `document` в `KNOWN_TOOL_TAGS` (`src/tools/auto-tags.ts:20`).

### 4.2 Поток

```
файл на диске
  → Registry.resolve(path)      расширение + magic-bytes (worker-free, первые байты)
  → Handler.detect(head)        чем файл является на самом деле
  → Handler.parse(source)       → DocumentIR
  → потребитель (map | read | index) → bound(...) → результат тула
```

Ошибка на любом шаге → fail-open с `cause` и записью `module:documents` (INV-D5).

### 4.3 `DocumentIR` — нормализованное представление

```ts
export interface DocumentIR {
  meta: {
    format: string;            // "xlsx" | "docx" | "pdf" | ...
    title?: string;
    pages?: number;            // PDF/PPTX
    sheets?: string[];         // таблицы
    bytes: number;
    degraded?: { reason: string };
  };
  outline: DocNode[];          // «карта»: заголовки / листы / секции, с уровнями
  blocks: DocBlock[];          // содержимое в порядке следования
}

export interface DocNode { id: string; level: number; title: string; kind: "doc"|"sheet"|"section"|"slide" }
export type DocBlock =
  | { kind: "heading";   level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list";      ordered: boolean; items: string[] }
  | { kind: "code";      lang?: string; text: string }
  | { kind: "table";     table: DocTable }
  | { kind: "figure";    caption?: string; ref: FigureRef };

export interface DocTable { caption?: string; header: string[]; rows: string[][]; range?: string; truncated?: boolean }
export interface FigureRef { kind: "raster"|"vector"; mime: string; bytes: number; note?: string }
```

`outline` — это и есть **карта** документа; `blocks` — адресуемые для чтения срезами
(по `id`/уровню/странице/листу/диапазону).

### 4.4 `DocumentHandler` и `DocumentRegistry`

```ts
export type HandlerGroup = "text" | "spreadsheet" | "office" | "pdf" | "image" | "geo";

export interface DocSource { path: string; bytes(): Promise<Uint8Array>; ext: string }
export interface ParseContext { logger: Logger; limits: DocLimits }

export interface DocumentHandler {
  id: string;                    // "xlsx"
  group: HandlerGroup;
  extensions: string[];          // [".xlsx"]
  mediaTypes?: string[];
  detect?(head: Uint8Array): boolean;   // magic-bytes (PK.., %PDF-, <svg)
  parse(ctx: ParseContext, source: DocSource): Promise<DocumentIR>;
}

export interface DocumentRegistry {
  register(h: DocumentHandler): void;
  resolve(path: string, head: Uint8Array): DocumentHandler | null;
  parse(ctx: ParseContext, source: DocSource): Promise<DocumentIR>;
  active(): { groups: HandlerGroup[]; handlers: string[] };  // для health()
}
```

Резолв учитывает расширение **и** magic-bytes (ZIP `PK\x03\x04` → офисный слой, `%PDF-`
→ PDF, `<svg`/`<?xml` → вектор/XML), чтобы не доверять имени файла слепо.

### 4.5 Вкл/выкл в коде (без настроек)

`src/modules/documents/handlers/index.ts`:

```ts
// Глобальный выключатель всего модуля (код, не конфиг).
export const DOCUMENTS_ENABLED = true;

// Группы, включаемые целиком. Убрал группу — её обработчики не регистрируются,
// а их зависимости выпадают из бандла.
export const ACTIVE_GROUPS: readonly HandlerGroup[] = [
  "text", "spreadsheet", "office", "pdf", "image", "geo",
];

// Точный список обработчиков (код). Убрал строку — формат выключен.
export const HANDLERS: readonly DocumentHandler[] = [
  csvHandler, tsvHandler, mdHandler, jsonHandler, htmlHandler, xmlHandler, yamlHandler,
  xlsxHandler, odsHandler, docxHandler, odtHandler, pptxHandler,
  pdfHandler, imageHandler, geoHandler,
];
```

`registry.ts` оставляет обработчики, чья `group ∈ ACTIVE_GROUPS` и которые есть в `HANDLERS`.
`DOCUMENTS_ENABLED = false` → модуль регистрируется пустым (ни одного тула), boot не падает
(`critical: false`).

### 4.6 Зависимости и вшивание в билд

- **OOXML/ODF** (xlsx/docx/pptx/ods/odt) — общий слой `ooxml.ts`/`odf.ts` на встроенном
  `node:zlib` + единственная новая деп-зависимость **`fast-xml-parser`**.
- **PDF** — **`pdfjs-dist`** (legacy build, извлечение текстового слоя без canvas).
- **Текст/таблицы/данные/гео** (csv/tsv/md/html/json/yaml/xml/geojson/gpx/svg) — руками или
  на уже имеющихся `yaml`; новых зависимостей нет.
- **Итого новых зависимостей: 2** (`fast-xml-parser`, `pdfjs-dist`).

Сборка сейчас — `bun build ./src/cli/main.ts --outfile ./dist/main.js --target node --format esm
--packages external` (`package.json:35`): зависимости резолвятся в рантайме из `node_modules`,
а в npm-пакет попадают только `dist/` и `bin/`. Требование «вшить в билд» выполняется
**отдельным шагом бандлинга**, который инлайнит именно документные зависимости в `dist/`,
**не трогая** `playwright` и прочие невшиваемые пакеты.

Так как деп-зависимость импортируется только своим обработчиком и регистрация идёт через
`HANDLERS`/`ACTIVE_GROUPS` (INV-D8), отключение группы в коде выпиливает её из бандла —
«выключено» означает «не только не вызывается, но и не поставляется».

Риск: `pdfjs-dist` крупный, worker/ESM в Node-бандле требует проверки. **W0 — обязательный
спайк бандлинга** до основной работы. Фолбэк при хрупком бандлинге — лёгкий чистый
TS-экстрактор текстового слоя PDF (решение по результату спайка, не сюрприз в середине).

**Спайк W0 — результаты (факт).** Проверка: `bun build <entry> --target node --format esm`
→ артефакт копируется в чистую temp-папку **без `node_modules`** → `node <artifact>`.

- `fast-xml-parser@5.11.2` (`scripts/documents-bundle-check.ts`): **вшивается**. Собрано
  37 модулей, артефакт **117.75 КБ**; запуск из temp без `node_modules` → `documents deps bundle OK`, exit 0.
- `pdfjs-dist@6.4.299` (legacy build, текстовый слой без canvas): **вшивается**. Собрано
  39 модулей, артефакт **3.50 МБ**; запуск из temp без `node_modules` → извлечён текст
  `"Hello"`, exit 0. Fake-worker вшит через хук `globalThis.pdfjsWorker = { WorkerMessageHandler }`
  (иначе pdfjs динамически импортирует `pdf.worker.mjs` рядом с бандлом и падает без него) —
  это и есть «чистый» способ инлайна worker без отдельного файла. **Фолбэк на чистый TS не нужен.**
  Побочные warning'и (не фатальны для текстового слоя): отсутствует optional
  `@napi-rs/canvas`; `standardFontDataUrl` не задан (влияет на рендер глифов, не на извлечение текста).

Вывод спайка: обе зависимости бандлятся в один ESM-артефакт под `--target node` и работают
без `node_modules`. Механизм вшивания — `scripts/build-documents.ts` (`build:documents`,
W0.3): список внешних пакетов выводится из `package.json` `dependencies` **минус**
`DOCUMENTS_DEPS = [fast-xml-parser, pdfjs-dist]`, каждый прочий пакет получает `--external`
(семантика `build:bundle` для всего остального сохранена; `playwright` не вшивается). Шаг
вставлен в `build:prod` перед `build:optimize`.

**Локи синхронизированы (оплачено 2026-10-16).** `package-lock.json` перегенерирован
(`npm install --package-lock-only`): содержит документные депы `fast-xml-parser@5.11.2` и
`pdfjs-dist@6.4.299` — версии совпадают с `bun.lock`; `package.json` не менялся. Долг был
`documents-lockfile-drift` — см. [debt.md](../agents/debt.md).

**Вшивание проверяется автоматически (оплачено W2).** `scripts/build-documents.ts` пишет
`--metafile`, а `scripts/inline-check.ts::missingInlined` падает (`exit 1`), если документная
деп, реально импортируемая `src/**`, отсутствует во входах `dist/main.js`. Покрыто
`tests/documents/inline-check.test.ts` (прежде был долг `documents-inline-unverified`).

**Честный пробел vision-изображений — `DEBT(documents-vision-image-seam)`.** Vision-путь
`document_read` (W4) отправляет в `ToolResult.images` полный base64 оригинала и **не
уменьшает** картинку (в отличие от `attach_image`); всё больше `MAX_VISION_BYTES` честно
отклоняется (`documents.image_too_large`), а не заваливает контекст. Ресайз модуль выполнить
не может: INV-D7 запрещает импорт `src/llm/*`, а MIME-карта и `buildDataUrl` в `media.ts`
дублируют `src/llm/image-utils.ts`. Критерий выхода — core-шов, отдающий ресайз + data-URL
для `ToolResult.images`; триггер — следующее изменение ядра/vision-пути. Запись — в
[debt.md](../agents/debt.md).

### 4.7 Тулы для модели

Максимум четыре тула (жёсткий бюджет 9B). Все — через `ModuleDef.tools()` →
`registerOwnedTools`, у каждого обязательный `security`.

| Тул | Назначение | Аргументы | security | Волна |
|---|---|---|---|---|
| `document_map` | Карта: оглавление/листы/таблицы/фигуры, размеры | `path` | `fs:read`, `pathArgs:["path"]` | W1 |
| `document_read` | Срез по селектору (страница/лист/секция/блок/диапазон) | `path`, `selector` | `fs:read`, `pathArgs:["path"]` | W1 |
| `document_index` | Пересборка индекса каталога документов | `dir` | `fs:read`, `pathArgs:["dir"]` | W5 |
| `document_find` | Поиск по индексу документов | `path\|dir`, `query` | `fs:read`, `pathArgs:["path","dir"]` | W5 |

- Тег `document` (в `KNOWN_TOOL_TAGS`) — сужение набора работает автоматически.
- `boundedOutput: true`; лимиты строк/токенов; таблицы обрезаются с `truncated`.
- **Никакого блока в системный промпт** — карта документа отдаётся по запросу (не жечь
  контекст маленькой модели).
- Растровые графики/карты: `document_map` отдаёт метаданные + пометку `raster`;
  `document_read` при vision-провайдере возвращает изображение (совместимо с `attach_image`),
  иначе — fail-open с причиной (INV-D5).
- Пользовательские строки ошибок — через `t()`; дружелюбные имена — `tool.friendly.*`.

### 4.8 Жизненный цикл, отказ, безопасность

```ts
// lifecycle.ts
export function documentsModuleDef(deps: DocumentsDeps): ModuleDef {
  const registry = buildRegistry();               // учитывает DOCUMENTS_ENABLED/ACTIVE_GROUPS/HANDLERS
  return {
    name: "documents",
    critical: false,                              // INV-5: отказ изолируется в degraded
    requires: [],
    setup: () => { registry.warm(); },            // прогрев/валидация зависимостей
    teardown: () => { registry.dispose(); },      // закрыть кэш индекса/документов
    health: () => registry.health(),              // { status, reason?: "pdfjs не загрузился" }
    tools: () => [documentMapTool(registry), documentReadTool(registry), /* W5 */],
    // configKeys() НЕ объявляется — настроек нет (INV-D3)
  };
}
```

- Отказ обращения к конкретному документу — fail-open с причиной и записью (INV-D5),
  отказ загрузки зависимости (например, `pdfjs-dist`) — группа помечается недоступной в
  `health()` и её тулы деградируют с внятным сообщением, boot не падает.
- Кэш индекса документов — отдельный файл `documents-cache.json` рядом с `index-cache.json`
  (каталог `<baseDir>/.mma`), с envelope+signature (по образцу `IndexCache`), изолирован
  от индексатора кода. **Формат (W5):** `{ version:1, root, signature, builtAt, entries }`,
  где `root` — абсолютный корень проиндексированного каталога, `entries` —
  `{ path, rel, mtimeMs, size, outline, chunks }`. `load()` валидирует версию, `root` и
  форму каждой записи; чужой/битый/старого формата кэш **игнорируется**, а не доверяется.
- **Лимиты индексации (W5, INV-D4):** обход каталога пропускает `.git`/`node_modules`/`.mma`,
  глубина ≤ `MAX_INDEX_DEPTH = 6`, файлов ≤ `MAX_DOCUMENTS = 300` (сверх — `truncated`);
  документ чанкуется блоками `IR`, чанк ≤ `DEFAULT_MAX_CHUNK_CHARS = 1200` символов,
  чанков на документ ≤ `DEFAULT_MAX_CHUNKS_PER_DOC = 200` (сверх — заметка в последнем
  чанке, длина строго ≤ капа); `document_find` отдаёт ≤ `FIND_LIMIT = 20` попаданий,
  сниппет ≤ `SNIPPET_CHARS = 240` символов. Неподдержанный/битый файл — пропуск со
  счётчиком, обход не роняется.
- Enforcement — целиком в `ToolExecutor` (INV-D6).

---

## 5. Тесты и гейты

- **Юнит по обработчикам:** fixture-байты → ожидаемый `DocumentIR` (для каждого активного
  формата). Для архивных — маленькие детерминированные фикстуры.
- **Реестр:** `resolve` по расширению и по magic-bytes; приоритет detect над расширением.
- **Переключатели (INV-D3):** исключение группы/обработчика снимает его из реестра и из
  `health()`; `DOCUMENTS_ENABLED=false` → тулов нет, boot зелёный.
- **Границы (INV-D2):** `handlers/*` импортируется извне только из `registry.ts`;
  внутри `handlers/` импорты между обработчиками/общим слоем свободны.
- **Fail-open (INV-D5):** битый/пустой/неподдерживаемый документ даёт запись
  `module:documents` в `session.jsonl` — тест, падающий без правки (правило 7).
- **Лимиты (INV-D4):** большая таблица/документ обрезается с `truncated`.
- **Общий гейт:** `bun test` + `bun run quality` (включая `check:arch`) зелёные; новые файлы
  проходят `tests/arch/file-size.test.ts`.

---

## 6. Волны

Скоуп режется по правилу 3 (одна задача — одна ветка, один контракт). Каждая волна завершается
проверяемым результатом и зелёным `bun test` + `bun run quality`.

| Волна | Содержание | Проверяемый результат |
|---|---|---|
| **W0** | Спайк бандлинга `fast-xml-parser` + `pdfjs-dist` в `dist/` | `dist/` поднимается с вшитыми документами-деками |
| **W1** | Субстрат (`ir/handler/registry/bound`), `module/lifecycle`, тулы `map`/`read`, текстовая группа (csv/tsv/md/html/json/yaml/xml) | Чтение и карта текстовых документов по-настоящему; гейты зелёные |
| **W2** | `ooxml`/`odf`, xlsx/ods/docx/odt/pptx | Карта/чтение офисных и табличных файлов |
| **W3** | PDF (текстовый слой) | Извлечение текста/оглавления PDF; сканы → честный fail-open |
| **W4** | image→vision, geo (GeoJSON/GPX; `.svg` **намеренно** уходит в `xml.ts` — текстовая группа) | Графики/карты: метаданные + vision или явная деградация |
| **W5** | Индексация корпуса: `document_index`/`document_find`, стоимость/бюджет | Поиск по многим документам, ограниченная выдача |

W1 — отдельная ветка `feat/documents-substrate` от `master`; W2–W5 — каждая своя ветка.

---

## 7. Решения и открытые вопросы

**Решено (брейншторм):**
- Подход **A** (реестр + `DocumentIR`), файлы сразу ≤300 строк.
- Зависимости разрешены, но **вшиваются в билд**; выключенный обработчик выпадает из бандла.
- Вкл/выкл — **в коде**, настроек (`configKeys`) нет.
- Тул-набор: W1 — `document_map` + `document_read`; `document_index`/`document_find` — W5.
- PDF — `pdfjs-dist` с фолбэком на чистый TS при хрупком бандлинге.

**Открыто:**
1. Судьба шести существующих scattered-switch'ей (INV-D1): сводить ли их к `DocumentRegistry`
   отдельной волной после W1–W5 или оставить (долг).
2. Формат индексного представления документов (W5) — плоские чанки vs блочные адреса из `IR`.
3. Нужен ли геокартам векторный слой сверх изображения (GeoJSON/GPX парсим; растровые — vision).

---

## Связанные документы

- [architecture v2](./2026-10-12-architecture-v2-design.md) — целевой каркас, INV-1…23
- [w1-module-host](./2026-10-13-w1-module-host-design.md) — контракт `ModuleDef`/`ModuleHost`
- [w2-enforcement](./2026-10-13-w2-enforcement-design.md) — `ToolSecurityDecl` в `ToolExecutor`
- [out-of-context-corpus](./2026-10-14-out-of-context-corpus-design.md) — корпусный Q&A (W5 пересекается)
- [debt.md](../agents/debt.md) — реестр долгов (правило 9)
- [modules.md](../agents/modules.md) — текущее устройство индексатора/памяти/веба
