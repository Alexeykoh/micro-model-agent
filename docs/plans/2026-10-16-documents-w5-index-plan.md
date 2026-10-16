# Модуль документов — W5: индексация корпуса (`document_index`/`document_find`)

> **Статус:** W5 — этот файл (финальная волна). Ветка `feat/documents-index` от `master`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [x]`) syntax for tracking.

**Goal:** Поиск по многим документам: рекурсивная индексация каталога (ограниченная),
кэш на диске рядом с `index-cache.json`, простой TF-поиск по чанкам, два новых тула —
`document_index` (пересобрать) и `document_find` (найти). Итого у модуля ровно **4 тула** —
жёсткий бюджет спеки для маленьких моделей.

**Architecture:** Всё под `src/modules/documents/`. Чанки выводятся **только** из
`DocumentIR` (INV-D2): `chunks.ts` не знает форматов. `corpus.ts` — дисковый кэш
(по образцу `src/modules/indexer/cache.ts`, но изолированный) + `indexDir`, который
ходит по каталогу, разрешает файл через `buildRegistry()`, парсит через
`fileSource`+`parseCtx` и чанкирует. Тулы — тонкие, `security` в `ToolExecutor`
(INV-D6), fail-open с записью `module:documents` (INV-D5), вывод ограничен (INV-D4).
Никаких ключей конфига (INV-D3). Файлы ≤300 строк, заголовки/JSDoc по-русски, без `as any`.

**Tech Stack:** Bun + TypeScript (strict, NodeNext), vitest через `bun test`.
Новых зависимостей нет.

**Спека:** [2026-10-16-documents-module-design.md](../specs/2026-10-16-documents-module-design.md)
(INV-D2/D3/D4/D5/D6/D7/D9)

**Предыдущие волны:** [W4](./2026-10-16-documents-w4-media-plan.md) ·
[W3](./2026-10-16-documents-w3-pdf-plan.md) ·
[W2](./2026-10-16-documents-w2-office-plan.md) ·
[W1/roadmap](./2026-10-16-documents-module-plan.md)

---

## File Structure (W5)

| Файл | Ответственность |
|---|---|
| `src/modules/documents/chunks.ts` | `chunkIR(ir, opts)` — IR → `DocChunk[]`; нарезка и кап чанков (INV-D4) |
| `src/modules/documents/corpus.ts` | `DocumentsCache` (envelope + валидация) + `indexDir(opts)` (обход каталога) |
| `src/modules/documents/search.ts` | `searchChunks(entries, query, limit)` — TF-скоринг + сниппеты (без деп) |
| `src/modules/documents/tools/document-index.ts` | Тул `document_index` (пересборка кэша) |
| `src/modules/documents/tools/document-find.ts` | Тул `document_find` (поиск по кэшу, сборка по требованию) |
| `src/modules/documents/module.ts` | Подключить оба новых тула (итого 4) |
| `src/modules/documents/index.ts` | Публичные типы/функции W5 |
| `src/i18n/en.json`, `src/i18n/ru.json` | Ключи `documents.*`, `tool.friendly.document_{index,find}` (симметрично) |
| `tests/documents/chunks.test.ts` | Чанкинг: секции, нарезка, кап, фигуры-маркеры |
| `tests/documents/corpus.test.ts` | Кэш (envelope/version/root/shape) + `indexDir` (skip/кап/битый файл) |
| `tests/documents/tools-index.test.ts` | `document_index`/`document_find` сквозной сценарий, бюджет, fail-open |
| `tests/documents/module.test.ts` (доп.) | Ожидание 4 тулов |

---

## Дизайн (константы и решения)

**Чанкинг (`chunks.ts`).** Один блок → один (или несколько при переполнении) чанк.
Текст блока: `heading`/`paragraph`/`code` → `text`; `list` → элементы с маркерами;
`table` → заголовок + строки через ` | `; `figure` → короткий маркер
`[figure: <kind> <mime> (<caption>)]`. Текущая секция — заголовок последнего
`heading` (или `meta.title` до первого). Нарезка по границам строк/пробелов в окне
`maxChunkChars`. Каждый чанк дополнительно клампится. Жёсткий кап
`maxChunksPerDoc`: при переполнении последний слот занимает чанк-заметка
(`[... truncated: N more chunks ...]`), т.е. `result.length ≤ cap` всегда.

- `DEFAULT_MAX_CHUNK_CHARS = 1200`
- `DEFAULT_MAX_CHUNKS_PER_DOC = 200`

**Кэш (`corpus.ts`).** Файл `<cacheDir>/documents-cache.json`, `cacheDir = join(baseDir, ".mma")`.
Envelope `{ version, root, signature, builtAt, entries }`, `CACHE_VERSION = 1`.
`load()` валидирует версию/`root`/форму каждой записи; чужой/битый кэш **игнорируется**,
не доверяется. `root` — абсолютный индексируемый каталог.

**Обход (`indexDir`).** Рекурсивно, пропуская `.git`/`node_modules`, глубина
`MAX_INDEX_DEPTH = 6`, файлов не больше `MAX_DOCUMENTS = 300` (далее — `truncated`).
Файл разрешается через `registry.resolve(path, head)` (первые 8 байт); не поддержан
или битый — `skipped += 1`, без исключения. `rel` — путь относительно `baseDir`
(forward-slash), чтобы его понял `document_read`.

**Поиск (`search.ts`).** Запрос делится по пробелам на термы; счёт — сумма вхождений
каждого терма в `text` (case-insensitive). Секция и путь добавляют небольшой вес.
Топ-N (`FIND_LIMIT = 20`), сниппет `SNIPPET_CHARS = 240`. Нет совпадений — честное
сообщение; нет кэша и нечего индексировать — fail-open с причиной (INV-D5).

---

### Task 0: План волны

- [x] Зафиксировать план W5 (этот файл) и закоммитить первым.
- [x] **Коммит** `docs(documents): план W5 — индексация корпуса`.

### Task 1: `chunks.ts` — IR → чанки

- [x] Падающий тест `tests/documents/chunks.test.ts`: секции, нарезка длинного абзаца,
  кап чанков (с заметкой), фигуры-маркеры, таблицы/списки.
- [x] Реализовать `chunkIR` + `DocChunk` + константы.
- [x] **Коммит** `feat(documents): чанкинг DocumentIR (W5)`.

### Task 2: `corpus.ts` — кэш + обход каталога

- [x] Падающий тест `tests/documents/corpus.test.ts`: envelope/version/root/shape
  (чужой кэш не грузится), `indexDir` на временном каталоге (.csv/.md), skip
  неподдержанного, cap документов, битый файл не роняет обход.
- [x] Реализовать `DocumentsCache` и `indexDir`.
- [x] **Коммит** `feat(documents): дисковый кэш и обход корпуса (W5)`.

### Task 3: `search.ts` + тул `document_index`

- [x] Падающий тест скоринга/бюджета в `tests/documents/tools-index.test.ts`.
- [x] Реализовать `search.ts`; реализовать `document_index`.
- [x] **Коммит** `feat(documents): тул document_index (W5)`.

### Task 4: тул `document_find`

- [x] Падающие тесты: попадание по индексу, no-match, бюджет top-N,
  fail-open без документов.
- [x] Реализовать `document_find` (загрузка/сборка кэша по требованию).
- [x] **Коммит** `feat(documents): тул document_find (W5)`.

### Task 5: проводка в модуль + i18n

- [x] `module.ts`: 4 тула; `index.ts`: экспорт типов W5.
- [x] Ключи `documents.*`/`tool.friendly.*` симметрично en/ru.
- [x] Обновить спеку при необходимости (формат кэша/лимиты).
- [x] **Коммит** `feat(documents): проводка тулов W5 и i18n`.

### Task 6: гейты

- [x] `tests/documents/module.test.ts` — ожидание 4 тулов.
- [x] `bun test tests/documents tests/arch` → зелёный (реальные числа).
- [x] `bun run quality` → exit 0; `bun run build:documents` → exit 0.
- [x] `bun test tests/i18n.test.ts` зелёный; файлы ≤300 строк; нет `as any`.
- [x] **Коммит** `test(documents): гейты W5 — индексация/поиск`.

---

## Self-Review (заполняется по завершении)

- **INV coverage:** INV-D2 (чанки/поиск только из `DocumentIR`) · INV-D3 (нет `configKeys`) ·
  INV-D4 (`boundText`, кап чанков/документов, top-N) · INV-D5 (fail-open + `module:documents`) ·
  INV-D6 (`security` в декларации, enforcement в executor) · INV-D7 (гейт границ модуля) ·
  INV-D9 (≤300 строк, без `as any`).
- **Known limitations:** TF-скоринг без стемминга/IDF; кэш — один корень на каталог;
  обход без инкрементального reuse (пересборка целиком при `document_index`).
