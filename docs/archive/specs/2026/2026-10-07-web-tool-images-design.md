# Web tool images — миниатюра, лайтбокс, персист — дизайн

- **Дата:** 2026-10-07
- **Ветка:** `feat/web-tool-images`
- **Статус:** дизайн утверждён, готов к написанию плана

## 1. Проблема

В ленте `mma web` карточка изображения рисуется **заглушкой** «◧ снимок экрана»
(`src/modules/webui/assets/js/feed/turn.ts:163-169`) для любого вызова `browser`
и `attach_image` — независимо от того, был ли снимок сделан, и без реальной
картинки. Она создаётся уже на `tool_start` и никогда не наполняется.

Причины:

- Реальные изображения тула (`ToolResult.images`) уходят **только** в контекст
  модели — `queueToolImages` (`src/core/agent/tool-images.ts`), точнее
  `tool-batch.ts:484`. В веб-клиент они не попадают вообще.
- SSE `tool_end` (`src/modules/webui/session/forward.ts:182-193`) несёт лишь
  текст `output`. Более того, веб-раннер синтезирует `ToolResult` из
  `ToolEvent` (`run-agent.ts:86-89`), а тот вообще не имеет поля изображений.
- `attach_image` кладёт картинку напрямую в `ctx.contextManager.addPendingImage`
  (`src/tools/attach-image.ts:115`) и ничего не возвращает в `result.images`.
- История (`src/modules/webui/session/history-api.ts`) картинок не хранит.

Итог: заглушка вводит в заблуждение и не может быть наполнена.

## 2. Цели / не-цели

**Цели:**

- Показывать **реальный** снимок браузера и вложенное изображение в ленте
  `mma web`: миниатюра + лайтбокс по клику.
- Персист и replay: после reload/переоткрытия сессии картинки снова видны.
- Ротация на сессию, чтобы папки не распухали.
- Единый путь доставки изображений тула (модель + веб + история).

**Не-цели:**

- Терминальный вывод — графики там нет, поведение не меняется.
- Вижн-путь модели: `ToolResult.images` по-прежнему data URL; доставка
  в провайдер не меняется.
- Replay пользовательских вложений композера (`composer` `uimg`) — отдельная
  тема; сейчас они не персистятся, это не трогаем.
- Показ изображений в MoE-пути (MoE-логирование и так вне скоупа).

## 3. Утверждённые решения

| Вопрос | Решение |
| --- | --- |
| Триггер снимка в ленте | Только явный `browser(action:"screenshot")` |
| Подача | Миниатюра (≤360px) + лайтбокс по клику |
| Персист/replay | Да, с диска по URL |
| Транспорт | Подход 2: серверное хранилище + отдаваемые URL |
| Ротация | `maxCount=30` **или** `maxBytes=100 МБ`, старейшие первыми |
| Что на диск | Полноразмерные байты (PNG вьюпорта; оригинал для attach) |
| `attach_image` | Единый путь через `ToolResult.images` |

## 4. Поток данных

```
tool handler
  ├─ result.images      = ImageUrlPart[]        → модель (data URL, ≤800px JPEG)
  └─ result.imageFiles  = ToolImageAsset[]       → диск (полноразмер, mime/bytes)
        │
tool-batch
  ├─ queueToolImages(contextManager, result.images)      (как сейчас)
  ├─ refs = slog.persistToolImages(...)                   → <session>/images/<id>.<ext>
  ├─ result.imageRefs = refs
  ├─ slog.logToolResult(..., refs)  → session.jsonl: tool_result.images = refs
  └─ onTool({type:"end", ..., imageRefs})
        │
        ├─ forwarder.onToolEnd → SSE tool_end.images = ["/api/sessions/<id>/images/<file>"]
        └─ (live) клиент рисует .imgcard
        │
reload → GET /api/sessions/<id>/history → tool_result.images = те же URL → replay
```

## 5. Хранилище

- Каталог: `<sessionDir>/images/`.
- Имя файла: `<epochMs>-<rand6>.<ext>`; `ext` и `mime` берутся из data URL
  (или из `imageFiles.mime`).
- Пишем полноразмерные байты: для браузера — сырой PNG вьюпорта из
  `ActionResult.screenshot`; для `attach_image` — декодированные байты его
  data URL (то, что уже получено, без повторного чтения).
- `ToolImageRef = { file: string; mime: string; bytes: number }`.
- Удаление сессии (`SessionStore.deleteSession`) уже рекурсивно сносит каталог —
  картинки уходят вместе с ней.
- Ротация при каждой записи: список файлов по mtime; пока
  `count > images.maxCount || totalBytes > images.maxBytes` — удаляем старейший.

**Шифрование сессии.** Если `sessionEncryption.enabled` — на диск **не пишем**
(скриншоты приватны). Live отдаётся inline data URL (см. §7), в истории —
пометка «недоступно». Replay в этом режиме не поддерживается осознанно.

## 6. Ядро

- Новый модуль `src/modules/session/image-store.ts`:
  - `decodeDataUrl(dataUrl): { bytes: Uint8Array; mime: string }`
  - `saveToolImage(dir, asset): ToolImageRef` (mkdir, write, вернуть ref)
  - `pruneToolImages(dir, { maxCount, maxBytes })`
  - `readToolImage(dir, name): { bytes; mime } | null` (для эндпоинта)
  - `isSafeImageName(name): boolean` (`^[A-Za-z0-9._-]+$`, без `..`, без разделителей)
- `src/tools/types.ts`: `ToolResult` получает
  `imageFiles?: ToolImageAsset[]`, `imageRefs?: ToolImageRef[]`, где
  `ToolImageAsset = { bytes: Uint8Array; mime: string }`.
- `SessionLogger` (`src/core/session-logger.ts`): новый метод
  `persistToolImages(assets) → ToolImageRef[]` (резолвит активный `sessionDir`
  через `getSessionDirectory`, уважает `maxCount/maxBytes`, скип при шифровании);
  `logToolResult` принимает `refs` и кладёт `images` в запись `tool_result`.
- `src/modules/session/store.ts`: `SessionLogEntry.tool_result` —
  `images?: ToolImageRef[]`; `SessionLogEntry` получает поле.
- `tool-batch.ts` (в блоке после `queueToolImages`, ~484-513):
  вычислить `assets`, вызвать `slog.persistToolImages`, записать в
  `result.imageRefs`, передать refs в `logToolResult` и в `onTool`-событие `end`.
- `src/core/types.ts`: `ToolEvent` (событие `end`) получает
  `imageRefs?: ToolImageRef[]`.
- `src/tools/browser.ts`: обработчик `screenshot` перестаёт зависеть от vision
  для **производства** картинки — всегда возвращает
  `imageFiles: [{ bytes: result.screenshot, mime: "image/png" }]`; в `images`
  (модельный data URL, ≤800px) кладёт только при `ctx.capabilities.vision`.
  Для невидящей модели `output` = текстовая пометка, но картинка для веба есть.
- `src/tools/attach-image.ts`: убрать `ctx.contextManager.addPendingImage`;
  вернуть `images: [{ type:"image_url", image_url:{ url:dataUrl } }]`.
  Единый путь очереди (`queueToolImages`) + персист.

## 7. Сервер

- Новый роут `GET /api/sessions/:id/images/:name` (группа `handleSessionsApi`,
  `src/modules/webui/session/sessions-api.ts`):
  - `isSafeImageName(name)` иначе `400 bad_request`;
  - сессия есть иначе `404`;
  - файл отсутствует → `404 not_found`;
  - успех — байты, `Content-Type: <mime>`,
    `Cache-Control: private, max-age=31536000, immutable`.
- `src/modules/webui/session/forward.ts`:
  - `onToolEnd` при `result.imageRefs?.length` кладёт
    `images = refs.map(r => "/api/sessions/" + owner + "/images/" + r.file)`;
  - **фолбэк без персиста** (сессия шифрована): если refs пусты, но
    `result.images?.length` — inline data URL (live-only). Нужны сырые
    `result.images`, поэтому `run-agent.ts` `resultFor` должен их сохранять
    (см. §6 `ToolEvent`; forwarder читает refs/образы из результата).
  - `owner` берётся из `opts.ownerRef.current` (уже используется в `onTurnEnd`).
- `src/modules/webui/session/history-api.ts`:
  - `normalizeHistory`/`mapLogEntry` получают `sessionId`;
  - `tool_result` → `images: e.images?.map(r => imageUrl(sessionId, r.file))`;
  - `HistoryEntry.images?: string[]`.
- `run-agent.ts`: `resultFor(ev)` расширяется полем `imageRefs`/`images` из
  `ToolEvent`.

## 8. Фронтенд

- `assets/js/feed/turn.ts`:
  - из `cardFor` **убрать** ветку `IMAGE_TOOLS` (никакой заглушки на старте);
  - в `onToolEnd` при `data.images?.length` нарисовать `.imgcard` с
    `<img loading="lazy" src=...>` + подпись
    (`web.card.browser_viewport` для `browser`, `web.card.attached_image` для
    `attach_image`); по клику — лайтбокс;
  - без картинок — ничего дополнительно (обычная строка тула).
- Новый `assets/js/lightbox.ts`: оверлей (не `innerHTML`), Esc/клик по фону —
  закрыть, кнопки «открыть в новой вкладке» и «копировать» (`copyText`);
  focus-trap и возврат фокуса по паттерну `dialog`.
- `assets/js/feed/history.ts`: `tool_result.images` → миниатюры через тот же
  `lightbox`; `img.onerror` → приглушённое `.imgcard-missing` с
  `web.card.image_removed` («снимок удалён (ротация)»).
- i18n новые ключи (en+ru): `web.card.image_removed`, `web.lightbox.close`,
  `web.lightbox.open_tab`, `web.lightbox.copy`, `web.lightbox.copied`.

## 9. Конфиг

- `images.maxCount` (int, default `30`), `images.maxBytes` (int, default
  `104857600`) — в `src/config/registry-extra.ts`, домен `images`.
- Показ в web-settings (Settings → Advanced) через generic controls.
- i18n: `config.key.images.maxCount`, `config.key.images.maxBytes` (en+ru).
- READ регистрируется автоматически (`allConfigNames()`/`configDefs()`).

## 10. Крайние случаи

- Файл вытеснен ротацией → история отдаёт URL, `<img>` даёт `onerror` →
  «удалён (ротация)»; live не затрагивается.
- Шифрование сессии → персиста нет, live inline, история «недоступно».
- Не видящая модель + `screenshot` → модели текст, пользователю картинка.
- `attach_image` с URL/файлом/буфером → единый персист.
- Небезопасное имя файла в URL → `400` (traversal-защита).
- `--json`/терминал: `ToolResult.imageFiles` не сериализуется в машинный вывод.
- Очень большой снимок (выше `maxBytes`) → пишем, затем ротация отчистит
  старейшие, включая, при необходимости, сам новый.

## 11. Тестирование

- `tests/session/image-store.test.ts`: decode, save, prune по count и bytes,
  traversal (`isSafeImageName`, `readToolImage` jail).
- `tests/core/session-logger-images.test.ts`: refs в `tool_result`, скип при
  шифровании.
- `tests/core/tool-batch-images.test.ts`: refs в result/событии, порядок
  модель→персист.
- `tests/tools/attach-image.test.ts`: единый путь (нет двойной очереди).
- `tests/modules/webui/session-images-api.test.ts`: эндпоинт 200/404/400,
  content-type, cache-control.
- `tests/modules/webui/history-images.test.ts`: URL в `tool_result`.
- Фронт (`happy-dom`): карточка при `tool_end.images`, отсутствие карточки без
  картинок, лайтбокс open/close, fallback `onerror`; guard «нет innerHTML».
- Опционально e2e `web-tool-images` (по явной команде).

## 12. Доки и версия

- AGENTS.md: новый подраздел (web tool images).
- `CHANGELOG.md`: **2.28.0** (MINOR — новое поведение, эндпоинт, конфиг).
- Правило проекта: релизные правки только после зелёных `bun test` +
  `tsc --noEmit` + `bun run quality`.
