# Web tool images — план реализации

> **Статус:** исполнено (2026-10-20) — image-store, `ToolResult.imageFiles`/`imageRefs`,
> персист картинок в логе, `images-api`, lightbox и image-card в UI. Чекбоксы проставлены по факту.

> [docs/specs/2026-10-07-web-tool-images-design.md](../specs/2026-10-07-web-tool-images-design.md).

**Goal:** реальные изображения тулов (`browser` screenshot, `attach_image`) в ленте
`mma web` — миниатюра + лайтбокс, с персистом, replay и ротацией.

**Architecture:** серверное хранилище `<sessionDir>/images/` + отдаваемые URL
(`/api/sessions/:id/images/:name`). Модель получает data URL как раньше; диск —
полноразмерные байты. Ref'ы едут через `ToolResult.imageRefs` → `ToolEvent` →
SSE `tool_end.images` и в `session.jsonl`.

**Tech Stack:** Bun + TS, vitest, happy-dom, ESM-фронтенд (`assets/js/**`).

---

## Task 1: `image-store` — хранилище и ротация

**Files:**
- Create: `src/modules/session/image-store.ts`
- Test: `tests/session/image-store.test.ts`

- [x] **Step 1: Тест**

```ts
// tests/session/image-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeDataUrl, saveToolImage, pruneToolImages, readToolImage, isSafeImageName,
} from "../../src/modules/session/image-store";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "img-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("image-store", () => {
  it("decodes a data URL to bytes + mime", () => {
    const { bytes, mime } = decodeDataUrl("data:image/png;base64,AQID");
    expect(mime).toBe("image/png");
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it("saves and reads back", () => {
    const ref = saveToolImage(dir, { bytes: Buffer.from([1, 2, 3]), mime: "image/png" },
      { maxCount: 30, maxBytes: 1e9 });
    expect(isSafeImageName(ref.file)).toBe(true);
    const got = readToolImage(dir, ref.file);
    expect(got && [...got.bytes]).toEqual([1, 2, 3]);
    expect(got?.mime).toBe("image/png");
  });

  it("prunes oldest by count", () => {
    for (let i = 0; i < 5; i++) {
      saveToolImage(dir, { bytes: Buffer.from([i]), mime: "image/png" },
        { maxCount: 2, maxBytes: 1e9 });
    }
    expect(readdirSync(join(dir, "images")).length).toBe(2);
  });

  it("prunes by total bytes", () => {
    const big = Buffer.alloc(10);
    for (let i = 0; i < 3; i++) {
      saveToolImage(dir, { bytes: big, mime: "image/png" },
        { maxCount: 100, maxBytes: 15 });
    }
    expect(readdirSync(join(dir, "images")).length).toBe(1);
  });

  it("rejects traversal names", () => {
    expect(isSafeImageName("../secret")).toBe(false);
    expect(isSafeImageName("a/b.png")).toBe(false);
    expect(readToolImage(dir, "../x.png")).toBeNull();
  });
});
```

- [x] **Step 2: Запустить — падает** `bun test tests/session/image-store.test.ts`

- [x] **Step 3: Реализация `src/modules/session/image-store.ts`**

```ts
/** Хранилище изображений тулов на сессии: запись, чтение, ротация. */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Ссылка на сохранённое изображение (попадает в session.jsonl и по сети). */
export interface ToolImageRef { file: string; mime: string; bytes: number; }

/** Полноразмерный ассет тула для персиста (в дополнение к model data URL). */
export interface ToolImageAsset { bytes: Uint8Array; mime: string; }

const IMG_DIR = "images";
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Безопасное имя файла (без разделителей и `..`) — защита от traversal. */
export function isSafeImageName(name: string): boolean {
  return NAME_RE.test(name) && name !== "." && name !== ".." && !name.includes("..");
}

const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
};

/** Декодирует `data:image/...;base64,...` в байты + mime. */
export function decodeDataUrl(dataUrl: string): { bytes: Buffer; mime: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error("not a base64 data URL");
  return { mime: m[1], bytes: Buffer.from(m[2], "base64") };
}

function imagesDir(sessionDir: string): string { return join(sessionDir, IMG_DIR); }

/** Сохраняет ассет и применяет ротацию; возвращает ref. */
export function saveToolImage(
  sessionDir: string,
  asset: ToolImageAsset,
  limits: { maxCount: number; maxBytes: number },
): ToolImageRef {
  const dir = imagesDir(sessionDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ext = EXT[asset.mime] ?? "bin";
  const file = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const bytes = Buffer.from(asset.bytes);
  writeFileSync(join(dir, file), bytes, { mode: 0o600 });
  const ref: ToolImageRef = { file, mime: asset.mime, bytes: bytes.length };
  pruneToolImages(sessionDir, limits);
  return ref;
}

/** Удаляет старейшие (по mtime) файлы, пока count/bytes выше лимитов. */
export function pruneToolImages(
  sessionDir: string,
  limits: { maxCount: number; maxBytes: number },
): void {
  const dir = imagesDir(sessionDir);
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir).map((name) => {
    const st = statSync(join(dir, name));
    return { name, mtime: st.mtimeMs, size: st.size };
  }).sort((a, b) => a.mtime - b.mtime);
  let count = entries.length;
  let total = entries.reduce((s, e) => s + e.size, 0);
  for (const e of entries) {
    if (count <= limits.maxCount && total <= limits.maxBytes) break;
    rmSync(join(dir, e.name), { force: true });
    count -= 1;
    total -= e.size;
  }
}

/** Читает файл по имени; небезопасное/отсутствующее — null. */
export function readToolImage(
  sessionDir: string,
  name: string,
): { bytes: Buffer; mime: string } | null {
  if (!isSafeImageName(name)) return null;
  const p = join(imagesDir(sessionDir), name);
  if (!existsSync(p)) return null;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const mime = Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
  return { bytes: readFileSync(p), mime };
}
```

- [x] **Step 4: `bun test tests/session/image-store.test.ts` → PASS**
- [x] **Step 5: Commit** `feat(session): image store with rotation for tool images`

---

## Task 2: Конфиг `images.maxCount` / `images.maxBytes`

**Files:**
- Modify: `src/config/registry-extra.ts` (добавить в `EXTRA_DEFINITIONS`)
- Modify: `src/config/types.ts` (поле `images?` в `AppConfig` + дефолт)
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/config/images-config.test.ts`

- [x] **Step 1: Тест** — `/config images.maxCount` читается/пишется, дефолт 30/104857600.
- [x] **Step 2: Дефолты** в `DEFAULTS` (`src/config/config.ts` или `registry.ts`, где лежит `DEFAULTS`):
  `images: { maxCount: 30, maxBytes: 104857600 }`.
- [x] **Step 3: `ConfigKeyDef`** в `registry-extra.ts`: типы `int`, домен `images`.
- [x] **Step 4: i18n** ключи `config.key.images.maxCount` / `maxBytes` (en+ru).
- [x] **Step 5: Проверить** `bun test tests/config` + `/config images.maxCount` вручную.
- [x] **Step 6: Commit** `feat(config): images.maxCount/maxBytes for tool image retention`

> Точные имена: `DEFAULTS` и формат `ConfigKeyDef` сверить с `src/config/registry.ts`
> и `registry-extra.ts` перед правкой (единый источник).

---

## Task 3: Типы — `ToolResult.imageFiles/imageRefs`, `ToolEvent.imageRefs`, лог

**Files:**
- Modify: `src/tools/types.ts` (`ToolResult`)
- Modify: `src/core/types.ts` (`ToolEvent`)
- Modify: `src/modules/session/store.ts` (`SessionLogEntry.tool_result.images`)

- [x] **Step 1:** В `src/tools/types.ts` в `ToolResult` добавить:

```ts
  /** Полноразмерные ассеты для диска/показа (модель получает `images`). */
  imageFiles?: import("../modules/session/image-store").ToolImageAsset[];
  /** Заполняет ядро после персиста; читают forwarder и лог. */
  imageRefs?: import("../modules/session/image-store").ToolImageRef[];
```

- [x] **Step 2:** В `src/core/types.ts` `ToolEvent` (end) добавить
  `imageRefs?: import("../modules/session/image-store").ToolImageRef[];`
- [x] **Step 3:** В `src/modules/session/store.ts` `SessionLogEntry` добавить
  `images?: import("./image-store").ToolImageRef[];`
- [x] **Step 4:** `tsc --noEmit` зелёный.
- [x] **Step 5: Commit** `feat(core): tool image refs/types for persistence`

---

## Task 4: `SessionLogger.persistToolImages` + refs в `logToolResult`

**Files:**
- Modify: `src/core/session-logger.ts`
- Test: `tests/core/session-logger-images.test.ts`

- [x] **Step 1: Тест** — при `result.imageFiles` в `tool_result` появляются `images`,
  файлы на диске; при включённом шифровании — `images` нет.

- [x] **Step 2: Реализация** (добавить методы; `images` в существующий `appendLog`):

```ts
import { saveToolImage, type ToolImageAsset, type ToolImageRef } from "../modules/session/image-store";

  /** Сохраняет ассеты тулов; пусто при шифровании сессии (приватность). */
  persistToolImages(assets: ToolImageAsset[] | undefined): ToolImageRef[] {
    const session = this.session;
    const meta = session?.getActiveMeta();
    if (!assets?.length || !session || !meta) return [];
    if (session.isEncryptionEnabled?.()) return [];
    const dir = session.getSessionDirectory(meta.id);
    const limits = this.imageLimits?.() ?? { maxCount: 30, maxBytes: 104_857_600 };
    return assets.map((a) => saveToolImage(dir, a, limits));
  }
```

  и в `logToolResult(call, result, duration, iteration, imageRefs?)`:
  в `appendLog({...})` добавить `...(imageRefs?.length ? { images: imageRefs } : {})`.

  `imageLimits` — опциональный сеттер из bootstrap (`() => ({maxCount, maxBytes})`).

- [x] **Step 3: `bun test tests/core/session-logger-images.test.ts` → PASS**
- [x] **Step 4: Commit** `feat(session): persist tool images into session log`

---

## Task 5: Wiring в `tool-batch`

**Files:**
- Modify: `src/core/agent/tool-batch.ts:481-514`
- Test: `tests/core/tool-batch-images.test.ts`

- [x] **Step 1:** После `queueToolImages(contextManager, result.images)` (~484):

```ts
      if (result.imageFiles?.length) {
        const refs = slog?.persistToolImages?.(result.imageFiles) ?? [];
        if (refs.length) result.imageRefs = refs;
      }
```

- [x] **Step 2:** В `onTool?.({ type: "end", ... })` (~488) добавить
  `imageRefs: result.imageRefs`.
- [x] **Step 3:** В `logToolResult(call, result, duration, iteration)` (~513) передать
  `result.imageRefs` (сигнатура из Task 4).
- [x] **Step 4:** Тест: handler с `imageFiles` → result.imageRefs заполнен, событие
  несёт refs, `logToolResult` вызван с refs.
- [x] **Step 5: Commit** `feat(core): persist tool images in tool batch`

---

## Task 6: `browser` всегда производит кадр; `attach_image` — единый путь

**Files:**
- Modify: `src/tools/browser.ts:153-165`
- Modify: `src/tools/attach-image.ts:107-124`
- Test: `tests/tools/browser-images.test.ts`, `tests/tools/attach-image.test.ts`

- [x] **Step 1:** `browser.ts` — всегда `imageFiles`, `images` только при vision:

```ts
      if (result.screenshot) {
        const imageFiles = [{ bytes: result.screenshot, mime: "image/png" }];
        if (ctx.capabilities?.vision) {
          return {
            success: result.success,
            output: result.output,
            images: [await screenshotToImagePart(result.screenshot)],
            imageFiles,
          };
        }
        return {
          success: result.success,
          output: formatScreenshotForTextModel(result.output),
          imageFiles,
        };
      }
```

- [x] **Step 2:** `attach-image.ts` — убрать `ctx.contextManager.addPendingImage`;
  вернуть part в `images`:

```ts
      const sizeKb = Math.round((dataUrl.length * 3) / 4 / 1024);
      return {
        success: true,
        output: t("image.attached", { source, size: `${sizeKb} KB` }),
        images: [{ type: "image_url", image_url: { url: dataUrl } }],
      };
```

- [x] **Step 3:** Тесты: невидящая модель → `images` нет, `imageFiles` есть;
  attach возвращает `images` и НЕ зовёт `addPendingImage`.
- [x] **Step 4: Commit** `feat(tools): always persist browser shots; unify attach_image`

---

## Task 7: Эндпоинт `GET /api/sessions/:id/images/:name`

**Files:**
- Create: `src/modules/webui/session/images-api.ts`
- Modify: `src/modules/webui/session/sessions-api.ts` (роут в `handleSessionsApi`)
- Test: `tests/modules/webui/session-images-api.test.ts`

- [x] **Step 1:** `images-api.ts`:

```ts
import type { ServerResponse } from "node:http";
import { readToolImage } from "../../session/image-store";
import type { SessionStore } from "../state";

/** Отдаёт байты изображения тула из `<sessionDir>/images`; иначе 400/404. */
export function handleSessionImage(res: ServerResponse, id: string, name: string, s: SessionStore): void {
  const dir = s.sessionManager?.getSessionDirectory?.(id);
  if (!dir || !s.sessionManager?.get(id)) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  const img = readToolImage(dir, name);
  if (!img) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  res.writeHead(200, {
    "Content-Type": img.mime,
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  res.end(img.bytes);
}
```

- [x] **Step 2:** Роут в `handleSessionsApi` (до `/log`):

```ts
  if (p.startsWith("/api/sessions/") && p.includes("/images/") && req.method === "GET") {
    const rest = p.slice("/api/sessions/".length);
    const cut = rest.indexOf("/images/");
    const id = decodeURIComponent(rest.slice(0, cut));
    const name = decodeURIComponent(rest.slice(cut + "/images/".length));
    handleSessionImage(res, id, name, s);
    return true;
  }
```

- [x] **Step 3:** Тест: 200 + content-type/cache-control; `../x` → 404; чужая сессия → 404.
- [x] **Step 4: Commit** `feat(webui): serve session tool images`

---

## Task 8: SSE `tool_end.images` + history replay

**Files:**
- Modify: `src/modules/webui/session/forward.ts:182-193`
- Modify: `src/modules/webui/session/run-agent.ts:86-89` (`resultFor`)
- Modify: `src/modules/webui/session/history-api.ts`
- Test: `tests/modules/webui/session-images-events.test.ts`, `tests/modules/webui/history-images.test.ts`

- [x] **Step 1:** `run-agent.ts` `resultFor(ev)` добавить
  `imageRefs: ev.imageRefs, images: ev.images`.
- [x] **Step 2:** `forward.ts onToolEnd` — собрать URL:

```ts
    onToolEnd(call, result, durationMs) {
      flush();
      const owner = opts.ownerRef?.current ?? null;
      const images = imageUrlsFor(owner, result.imageRefs, result.images);
      sink({
        type: "tool_end", ts: Date.now(), toolCallId: call.id, name: call.name,
        success: result.success, durationMs,
        output: stripAnsi(redactContextSecrets(clipToolOutput(call.name, result.output || ""))),
        ...(images.length ? { images } : {}),
      });
    },
```

  где `imageUrlsFor`: refs → `/api/sessions/<owner>/images/<file>`; если refs нет,
  а `result.images` есть (шифрованная сессия) — inline data URL.

- [x] **Step 3:** `history-api.ts`: `normalizeHistory(entries, tail, fallback, sessionId)`,
  `mapLogEntry(e, sessionId)` — `tool_result`:
  `images: e.images?.map(r => "/api/sessions/" + sessionId + "/images/" + r.file)`;
  `HistoryEntry.images?: string[]`. Обновить вызов в `handleSessionHistory`.

- [x] **Step 4:** Тесты: событие несёт URL; history несёт URL.
- [x] **Step 5: Commit** `feat(webui): deliver tool image URLs over SSE and history`

---

## Task 9: Фронтенд — лайтбокс, карточка, replay

**Files:**
- Create: `src/modules/webui/assets/js/lightbox.ts`
- Modify: `src/modules/webui/assets/js/feed/turn.ts` (убрать заглушку, рисовать img)
- Modify: `src/modules/webui/assets/js/feed/history.ts` (replay)
- Modify: `src/modules/webui/assets/styles.css` (`.imgcard`, `.imgcard-missing`, оверлей)
- Modify: `src/modules/webui/assets/index.html` (контейнер оверлея)
- Modify: `src/modules/webui/assets/app.ts` (импорт/инициализация)
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/webui-tool-images-dom.test.ts`

- [x] **Step 1:** `lightbox.ts` — `openLightbox(src, caption)`, `initLightbox()`:
  оверлей, `img` через `document.createElement`, Esc/фон — закрыть,
  «открыть в новой вкладке» (`<a target=_blank>`), «копировать» (`copyText`).
  Никакого `innerHTML`.
- [x] **Step 2:** `turn.ts` — в `cardFor` удалить ветку `IMAGE_TOOLS`;
  вынести `imageCard(name, url)`; в `onToolEnd` перед `renderToolOutput`:

```ts
  if (Array.isArray(data.images) && data.images.length) {
    for (const url of data.images) {
      const card = imageCard(data.name, url);
      if (card) insertAfter(line, card);
    }
  }
```

- [x] **Step 3:** `history.ts` — в `tool_result` при `entry.images` рисовать
  миниатюры; `img.addEventListener("error", ...)` → `.imgcard-missing`
  (`web.card.image_removed`).
- [x] **Step 4:** i18n (en+ru): `web.card.image_removed`, `web.lightbox.close`,
  `web.lightbox.open_tab`, `web.lightbox.copy`, `web.lightbox.copied`.
- [x] **Step 5:** CSS `.imgcard`, `.imgcard img`, `.imgcard-missing`, `.lightbox`.
- [x] **Step 6:** Тесты happy-dom: карточка при `images`, нет без; лайтбокс
  open/close; fallback `onerror`; guard «нет innerHTML».
- [x] **Step 7:** Проверка `tsc -p tsconfig.frontend.json` + `bun test`.
- [x] **Step 8: Commit** `feat(webui): render tool screenshots with lightbox and replay`

---

## Task 10: Доки, changelog, quality gate

**Files:**
- Modify: `AGENTS.md` (новый подраздел), `CHANGELOG.md` (2.28.0)

- [x] **Step 1:** AGENTS.md — подраздел «Web Tool Images».
- [x] **Step 2:** CHANGELOG `## [2.28.0]` (Added/Fixed).
- [x] **Step 3:** `bun test` + `tsc --noEmit` + `bun run quality` → зелёные.
- [x] **Step 4: Commit** `docs: AGENTS + changelog for web tool images (2.28.0)`

---

## Self-review

- Покрытие спеки: хранилище/ротация (T1,T2), ядро (T3,T4,T5), тулы (T6),
  эндпоинт (T7), SSE/history (T8), фронт/лайтбокс/replay (T9), доки (T10).
- Шифрование — T4 (скип) + T8 (inline-фолбэк).
- Риск: точные имена `DEFAULTS`/`ConfigKeyDef`/`ImageUrlPart`/`getSessionDirectory`
  сверить при реализации (T2/T4/T8).
