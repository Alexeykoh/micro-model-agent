# Модуль документов — W4: растровые изображения (vision) и geo-форматы

> **Статус:** исполнено (2026-10-20) — W4 (media: изображения/аудио-видео) реализован в master.
> Известный долг: vision-путь `document_read` не уменьшает растр — см.
> `DEBT(documents-vision-image-seam)` в [`docs/agents/debt.md`](../agents/debt.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [x]`) syntax for tracking.

**Goal:** Две новые группы обработчиков модуля `documents`:

1. **`image`** — растровые изображения (`.png .jpg .jpeg .gif .webp .bmp`) сводятся к
   `DocumentIR` с одним `figure`-блоком `ref.kind:"raster"` и MIME. Текст не извлекается.
   Картинка попадает в контекст модели только через **vision-путь** тула `document_read`:
   если у активной модели `capabilities.vision === true` и есть `contextManager`, тул отдаёт
   `ToolResult.images = [{ type:"image_url", image_url:{ url: dataUrl } }]`; иначе —
   fail-open с причиной (`documents.needs_vision`, INV-D5).
2. **`geo`** — GeoJSON (`.geojson`) и GPX (`.gpx`): outline по фичам/точкам/трекам +
   bounded код-блок. `meta.format` = `geojson`/`gpx`, `meta.degraded` при неразборе
   (INV-D5).

**Architecture:** Обработчики под `handlers/` (INV-D2), вкл/выкл — в `handlers/index.ts`
(`ACTIVE_GROUPS` + `HANDLERS`, INV-D3). Потребители видят только `DocumentIR`; вспомогательный
хелпер `media.ts` (распознавание растровой фигуры + сборка data URL через `node:buffer`) —
на стороне потребителей, без импорта `handlers/*` (INV-D2/D7). `gpX` разбирается через
`ooxml.ts#parseXml` (единственный импортёр `fast-xml-parser`, INV-D8). Весь текст — через
`boundText`/`boundLine` (INV-D4).

**Tech Stack:** Bun + TypeScript (strict, NodeNext), vitest через `bun test`.
Новых зависимостей нет.

**Спека:** [2026-10-16-documents-module-design.md](../specs/2026-10-16-documents-module-design.md)
(INV-D2/D3/D4/D5/D6/D7/D8/D9)

**Предшествующая волна:** [2026-10-16-documents-w3-pdf-plan.md](./2026-10-16-documents-w3-pdf-plan.md) (W3)

---

## File Structure (W4)

| Файл | Ответственность |
|---|---|
| `src/modules/documents/handlers/image.ts` | Растр → IR (группа `image`): magic-detect, MIME-карта, `figure`+outline. **`.svg` не заявлен** (его берёт `xml.ts`) |
| `src/modules/documents/handlers/geo.ts` | GeoJSON + GPX → IR (группа `geo`): outline + bounded код, `degraded` при неразборе |
| `src/modules/documents/media.ts` | Хелперы потребителя: распознать растровую фигуру IR + собрать `data:`-URL через `node:buffer` |
| `src/modules/documents/tools/document-read.ts` | Vision-путь: `capabilities.vision` + `contextManager` → `images`; иначе fail-open `documents.needs_vision` |
| `src/modules/documents/tools/run.ts` | `rejectResult` — fail-open с готовым сообщением модели + записью (INV-D5) |
| `src/modules/documents/handlers/index.ts` | Включить `"image"`,`"geo"` + `imageHandler`, `geojsonHandler`, `gpxHandler` (INV-D3) |
| `src/modules/documents/handlers/{json,yaml,xml,csv,xlsx,ods,pptx}.ts` | `boundLine` на `title` узлов outline (INV-D4) |
| `src/i18n/en.json`, `src/i18n/ru.json` | Ключи `documents.needs_vision`, `documents.image_attached` (симметрично) |
| `tests/documents/handlers-image.test.ts` | Magic-detect, figure/outline, mime, `document_map` |
| `tests/documents/handlers-geo.test.ts` | GeoJSON FeatureCollection → outline; GPX → outline; degraded на мусор |
| `tests/documents/tools.test.ts` (доп.) | Vision-путь: без vision → fail-open + диагностика; vision+ctx → `images` с data URL |
| `tests/documents/handlers-text.test.ts` / `handlers-text2.test.ts` (доп.) | Огромный заголовок клампится (INV-D4, Task 4) |
| `tests/documents/registry.test.ts` (доп.) | `.png`/`.geojson`/`.gpx` резолвятся под нужными группами |

---

### Task 0: План волны

- [x] Зафиксировать план W4 (этот файл) и закоммитить первым.
- [x] **Коммит** `docs(documents): план W4 — растр/vision + geo`.

### Task 1: Обработчик изображений (`group:"image"`)

- [x] Падающий тест `tests/documents/handlers-image.test.ts`: PNG/JPEG/GIF/WEBP/BMP magic →
  `figure`/`ref.kind==="raster"`/mime; `detect` по каждому magic; размер/outline/`meta.title`.
- [x] Реализовать `handlers/image.ts`: локальная MIME-карта, magic-detect, `parse`.
- [x] **Коммит** `feat(documents): обработчик растровых изображений (W4)`.

### Task 2: Vision-путь `document_read` + i18n

- [x] Падающий тест: без vision → `success:false` + `documents.needs_vision` + диагностика;
  vision + `contextManager` → `images` с `data:image/...;base64,`.
- [x] `media.ts`: `rasterMime(ir)`, `buildDataUrl(bytes, mime)`.
- [x] `run.ts`: `rejectResult`. `document-read.ts`: ветка vision.
- [x] Ключи `documents.needs_vision`/`documents.image_attached` в `en.json`/`ru.json`.
- [x] **Коммит** `feat(documents): vision-путь document_read (W4)`.

### Task 3: Обработчик geo (`group:"geo"`)

- [x] Падающий тест `tests/documents/handlers-geo.test.ts`.
- [x] Реализовать `handlers/geo.ts` (GeoJSON + GPX через `parseXml`).
- [x] **Коммит** `feat(documents): обработчик geo (GeoJSON/GPX) (W4)`.

### Task 4: Сквозная граница заголовков (INV-D4)

- [x] `boundLine` на outline-`title` в `json/yaml/xml/csv/xlsx/ods/pptx`.
- [x] Тест на кламп огромного заголовка.
- [x] **Коммит** `fix(documents): границы outline-заголовков (W4)`.

### Task 5: Переключатели (INV-D3)

- [x] `handlers/index.ts`: `"image"`,`"geo"` в `ACTIVE_GROUPS`, обработчики в `HANDLERS`,
  убрать placeholder `→ W4`.
- [x] **Коммит** `feat(documents): включаю группы image/geo (W4)`.

### Task 6: Фикстуры, registry/toggles-тесты

- [x] Кейсы реестра: `.png`/`.geojson`/`.gpx` под своими группами.
- [x] **Коммит** `test(documents): реестр image/geo (W4)`.

### Task 7: Полная проверка

- [x] `bun test tests/documents tests/arch` → зелёный (реальные числа).
- [x] `bun run quality` → exit 0.
- [x] `bun run build:documents` → exit 0 (без новых деп).
- [x] Файлы ≤300 строк; нет `as any`; `bun test tests/i18n.test.ts` зелёный.

---

## Self-Review

- **INV coverage:** INV-D2 (обработчики под `handlers/`; `media.ts` — потребитель, только
  `ir`), INV-D3 (`"image"`/`"geo"` + обработчики в `index.ts`), INV-D4 (`boundText`/`boundLine`
  везде), INV-D5 (нет vision → причина + запись; мусор → `degraded`/fail-open),
  INV-D6 (политику не реализует), INV-D7 (никакого `src/llm/*`; data URL через `node:buffer`),
  INV-D8 (`parseXml` из `ooxml.ts`), INV-D9 (≤300 строк, без `as any`).
- **Решения:**
  - Растр распознаётся по IR (`figure` с `ref.kind:"raster"`), а не по импорту обработчика —
    потребитель не нарушает INV-D2.
  - Data URL собирается `Buffer.from(bytes).toString("base64")` — без `llm/image-utils`
    (INV-D7).
  - WEBP magic при обрезанной до 8 байт голове (`registry`) доверяет `RIFF`+расширению;
    полный magic `RIFF....WEBP` проверяется, когда байт достаточно.
- **Known limitations:**
  - Из растра не извлекается текст (OCR нет) — только vision-передача.
  - Векторные изображения (`.svg`) остаются в текстовой группе `xml.ts`.
  - `.geojson` не проверяется на схему глубже `type:"FeatureCollection"`/`features`.

---

## Правки ревью (W4)

Ревью нашло три важные проблемы и мелочи; исправлено в ветке `feat/documents-media`:

- **Лимит vision-payload (INV-D4).** `document_read` base64-кодировал полный оригинал без
  границы. Добавлена константа `MAX_VISION_BYTES` (5 MiB, `media.ts`): байты сверх лимита →
  fail-open `rejectResult` с `documents.image_too_large` (путь + лимит) и диагностикой
  `module:documents`, а не гигантский payload. Тест — в `tests/documents/tools.test.ts`.
  См. `DEBT(documents-vision-image-seam)`: ресайза нет (INV-D7 запрещает `src/llm/*`).
- **MIME из magic-байтов, а не расширения.** `handlers/image.ts#detectRaster` возвращает
  `{ mime } | null`; фигура берёт MIME оттуда, расширение — лишь фолбэк. Тест: `.png`-файл с
  JPEG-байтами → `ref.mime === "image/jpeg"` (и data URL использует его). `it.each` по
  расширениям заменён.
- **Границы geo (INV-D4).** `GEO_OUTLINE_CAP = 200` в `handlers/geo.ts` (как `xml.ts` капит
  на 60): большой FeatureCollection/GPX даёт усечённый outline + честный `meta.degraded`.
  `map.ts#renderDocumentMap` оборачивает весь вывод в `boundText(..., DEFAULT_DOC_LIMITS)` —
  `document_map` ограничен независимо от обработчика.

Мелочи: комментарий, что `selector` игнорируется для растра; `documents.needs_vision` и
`documents.image_too_large` несут `{path}`; W4-строка спеки уточняет, что `.svg` **намеренно**
уходит в `xml.ts`.

**Известное ограничение (не баг):** модуль не уменьшает изображения — только кап по байтам
(`MAX_VISION_BYTES`); полноценный ресайз — core-шов, см. `DEBT(documents-vision-image-seam)`.
