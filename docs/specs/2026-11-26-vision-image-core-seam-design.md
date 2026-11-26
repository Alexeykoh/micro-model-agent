# Core-шов подготовки vision-изображений для модуля документов

**Дата:** 2026-11-26 · **Статус:** accepted · **Ветка:** `feat/vision-image-core-seam`
**Оплачивает:** долг `documents-vision-image-seam` из `docs/agents/debt.md`.

## 1. Проблема

`document_read` в режиме vision уносит в `ToolResult.images` полный base64 оригинала
растра. Порог `MAX_VISION_BYTES = 5 MiB` проверяется **до** подготовки данных, поэтому
большой файл честно отклоняется, а не уменьшается. Параллельно `media.ts` собрал
собственный `buildDataUrl`, дублирующий `src/llm/image-mime.ts` (`rawRasterDataUrl`).
Модуль не может импортировать ресайз напрямую: **INV-D7** (Spec
[2026-10-16-documents-module-design](./2026-10-16-documents-module-design.md) §3)
запрещает ему `src/llm/*`.

## 2. Решение

Ядро предоставляет публичный порт через **Spec
[architecture v2](./2026-10-12-architecture-v2-design.md)** §1 (INV-3: модуль зависит
только от `src/core/api/**`):

```ts
export interface ImageResizePort {
  prepare(bytes: Uint8Array, mime: string): Promise<PreparedVisionImage>;
}
export interface PreparedVisionImage {
  dataUrl: string;
  mime: string;
  bytes: number;
  resized: boolean;
}
```

- Реализация лежит в ядре (`src/core/vision-image.ts`) и переиспользует уже
  существующий путь `src/llm/image-utils.ts`: `resizeToJpegDataUrl` (Bun Image,
  800 px, JPEG quality 60) с фолбэком на `rawRasterDataUrl`.
- Поле `resized` делает отказ честным: если `Bun.Image` недоступен или ресайз не
  удался, модуль получает `resized: false` и исходный data URL, а не «успешное
  уменьшение».
- Порт реэкспортируется из `src/core/api/index.ts`. Модуль получает его аргументом
  фабрики `documentsModuleDef(imageResize: ImageResizePort = coreImageResize)` —
  замыкание тула захватывает порт. `ModuleCtx.extensions` не используется (сейчас
  мёртвый шов), `ModuleDef.tools()` не меняется.
- `document_read` вызывает порт **до** проверки лимита и сравнивает размер уже
  подготовленного изображения; при превышении — прежний честный отказ
  `documents.image_too_large`.
- Локальный `buildDataUrl` удаляется из `src/modules/documents/media.ts`; `rasterMime`
  и `MAX_VISION_BYTES` остаются. В `tests/arch/documents-boundaries.test.ts`
  добавляется гвард «модуль документов не импортирует `src/llm/*`».

## 3. Что не меняется

- Публичный REST/SSE-контракт, формат `session.jsonl` и конфига — без изменений.
- `ToolResult.images` и i18n-ключи `documents.needs_vision` /
  `documents.image_too_large` / `documents.image_attached` — без изменений.
- Регистрация тулов: как и раньше, только через `ModuleHost.collectTools()` и
  `registerOwnedTools()` (INV-2).

## 4. Критерий выхода

1. `document_read` вызывает порт, а не локальный `buildDataUrl`; результат порта
   (data URL + mime) уходит в `ToolResult.images`.
2. Тест с подставным портом доказывает, что байты исходника и MIME передаются в
   шов и что возвращённый data URL используется.
3. Гвард архитектуры падает при импорте `src/llm/*` из `src/modules/documents/**`.
4. Якорь долга снят из кода и из
   `docs/agents/debt.md`, строка перенесена в «Оплачено».
5. `bun test` и `bun run quality` зелёные.
