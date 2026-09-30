# Web UI Sidebar Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) or
> superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Превратить сайдбар `mma web` в вкладки Session / Map / Trace: квадратные
иконки сверху + имя активной вкладки под ними; Map показывает состояние индексации
карты проекта; Trace — живой лог событий хода с master-detail (клик → сайдбар
расширяется вдвое и справа показывает метаданные, аргументы и вывод).

**Architecture:** преимущественно клиентская фича — новый leaf-модуль
`assets/js/sidebar.js` (вкладки, Trace-буфер, Map-рендер, master-detail), разметка в
`index.html`, CSS в `styles.css`, wiring в `app.js`. Бэкенд расширяется точечно:
`ProjectMapInfo` (timestamp/watcher/languages/indexing) в host-контракте, метод
`IndexerModule.mapInfo()`, `builtAt` в кэше индекса и роут `POST /api/index`.

**Tech Stack:** vanilla ESM (web assets), TypeScript strict, vitest (`bun test`), i18n en/ru.

**Спека:** `docs/specs/2026-09-30-webui-sidebar-tabs-design.md` (approved).
**Ветка:** `feat/webui-sidebar-tabs` (активна).

---

### Task 1: Host-контракт `ProjectMapInfo`

**Files:**
- Modify: `src/core/host.ts` (тип снапшота, строки 44–45)

- [ ] **Step 1: Расширить `HostStateSnapshot.projectMap`**

Заменить строку 45 и добавить типы выше интерфейса `HostStateSnapshot`:

```ts
/** Разбивка карты проекта по языку (для вкладки Map). */
export interface ProjectMapLanguage {
  language: string;
  files: number;
  symbols: number;
}

/** Статистика карты проекта, отдаваемая веб-сайдбару. */
export interface ProjectMapInfo {
  indexed: boolean;
  /** Обход идёт прямо сейчас. */
  indexing?: boolean;
  files: number;
  symbols: number;
  tokens: number;
  /** Время сборки индекса (epoch ms) или null. */
  updatedAt?: number | null;
  languages?: ProjectMapLanguage[];
  /** Вотчер индексатора активен. */
  watcher?: boolean;
}
```

В `HostStateSnapshot`:

```ts
  /** Статистика карты проекта; `indexed:false`, пока обход не завершён. */
  projectMap?: ProjectMapInfo;
```

- [ ] **Step 2: Typecheck**

Run: `tsc --noEmit`
Expected: PASS (расширение обратно совместимо; старый объект в `module.ts` пока не
соответствует `indexing`-опциональности — это правится в Task 3, до него ошибок нет,
т.к. все новые поля опциональны кроме существующих).

- [ ] **Step 3: Commit**

```bash
git add src/core/host.ts
git commit -m "feat(webui): add ProjectMapInfo host contract"
```

---

### Task 2: `IndexerModule.mapInfo()` + builtAt/watcher/indexing

**Files:**
- Modify: `src/modules/indexer/cache.ts` (envelope + getter)
- Modify: `src/modules/indexer/module.ts` (`buildIndex`/`refresh`/`watch`/`mapInfo`/`stats`)
- Test: `tests/indexer-module.test.ts`, `tests/modules/indexer/cache.test.ts`

- [ ] **Step 1: Написать падающий тест `mapInfo`**

Добавить в `tests/indexer-module.test.ts` (следуя существующим helper'ам файла для
создания модуля над temp-деревом — использовать тот же `IndexerModule` + `mkdtemp`):

```ts
it("mapInfo reports counts, languages, builtAt and watcher state", async () => {
  // ... build a temp dir with two .ts files and one .md (existing test helper) ...
  const mod = new IndexerModule({ baseDir: dir, cacheDir: cacheDir });
  expect(mod.mapInfo()).toMatchObject({ indexed: false, indexing: false, files: 0, watcher: false });
  await mod.buildIndex();
  const info = mod.mapInfo();
  expect(info.indexed).toBe(true);
  expect(info.files).toBe(3);
  expect(typeof info.updatedAt).toBe("number");
  expect(info.languages?.[0]).toMatchObject({ language: "typescript", files: 2 });
  mod.watch();
  expect(mod.mapInfo().watcher).toBe(true);
  mod.unwatch();
  expect(mod.mapInfo().watcher).toBe(false);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `bun test tests/indexer-module.test.ts -t "mapInfo"`
Expected: FAIL — `mod.mapInfo is not a function`.

- [ ] **Step 3: `cache.ts` — `builtAt`**

В `CacheEnvelope` добавить `builtAt?: number;`. В классе:

```ts
  private cachedBuiltAt: number | null = null;
```

В `load()` после `this.cache = parsed.result;` — добавить
`this.cachedBuiltAt = typeof parsed.builtAt === "number" ? parsed.builtAt : null;`.
В `save()` — `builtAt: Date.now()` в `envelope` и `this.cachedBuiltAt = Date.now();`.
В `invalidate()` — `this.cachedBuiltAt = null;`.
Добавить геттер:

```ts
  /** Время сборки кэшированного индекса (epoch ms) или null. */
  getBuiltAt(): number | null {
    return this.cachedBuiltAt;
  }
```

- [ ] **Step 4: `module.ts` — поля и методы**

Заменить поле `statsCache` (строка 32) на:

```ts
  private mapCache: { index: IndexResult; value: ProjectMapInfo } | null = null;
  private indexing = false;
  private builtAt: number | null = null;
  private watcherActive = false;
```

Импорт типа: `import type { ProjectMapInfo } from "../../core/host";`.

`buildIndex()` — обернуть обход в `indexing`, выставить `builtAt`:

```ts
  async buildIndex(): Promise<IndexResult | null> {
    if (this.index) return this.index;

    const cached = this.cache.load();
    if (cached) {
      this.index = cached;
      this.builtAt = this.cache.getBuiltAt() ?? Date.now();
      return cached;
    }

    this.indexing = true;
    try {
      const result = await this.indexer.walk();
      this.cache.save(result);
      this.index = result;
      this.builtAt = Date.now();
      return result;
    } catch {
      return null;
    } finally {
      this.indexing = false;
    }
  }
```

`refresh()` — сбросить `builtAt` перед перестройкой:

```ts
  async refresh(): Promise<IndexResult | null> {
    this.cache.invalidate();
    this.index = null;
    this.builtAt = null;
    return this.buildIndex();
  }
```

`watch()` — после успешной подписки `this.watcherActive = true;` (в конце `try`);
`unwatch()` — в начале `this.watcherActive = false;`.

Заменить `stats()` на реализацию через `mapInfo()` и добавить `mapInfo()`:

```ts
  /**
   * Полная статистика карты для сайдбара: счётчики, время сборки, разбивка по
   * языкам, статус вотчера/обхода. Кэшируется на объект индекса, чтобы поллинг
   * `/api/state` не пересобирал разбивку.
   */
  mapInfo(): ProjectMapInfo {
    if (!this.index) {
      return {
        indexed: false,
        indexing: this.indexing,
        files: 0,
        symbols: 0,
        tokens: 0,
        updatedAt: this.builtAt,
        languages: [],
        watcher: this.watcherActive,
      };
    }
    if (this.mapCache && this.mapCache.index === this.index) {
      return { ...this.mapCache.value, indexing: this.indexing, watcher: this.watcherActive };
    }
    const symbols = this.index.files.reduce((n, f) => n + f.exports.length, 0);
    const langMap = new Map<string, { files: number; symbols: number }>();
    for (const f of this.index.files) {
      const lang = f.language || "other";
      const cur = langMap.get(lang) ?? { files: 0, symbols: 0 };
      cur.files += 1;
      cur.symbols += f.exports.length;
      langMap.set(lang, cur);
    }
    const languages = [...langMap.entries()]
      .map(([language, v]) => ({ language, ...v }))
      .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language))
      .slice(0, 8);
    const value: ProjectMapInfo = {
      indexed: true,
      files: this.index.files.length,
      symbols,
      tokens: this.estimateTokens(this.formatMap(this.index)),
      updatedAt: this.builtAt,
      languages,
      watcher: this.watcherActive,
    };
    this.mapCache = { index: this.index, value };
    return { ...value, indexing: this.indexing };
  }

  /** Компактная статистика карты для совместимости (null до конца обхода). */
  stats(): { files: number; symbols: number; tokens: number } | null {
    const info = this.mapInfo();
    return info.indexed ? { files: info.files, symbols: info.symbols, tokens: info.tokens } : null;
  }
```

- [ ] **Step 5: Тест кэша `builtAt`**

В `tests/modules/indexer/cache.test.ts`:

```ts
it("persists and reads back builtAt", () => {
  const c = new IndexCache(dir); // существующий temp-каталог файла
  const result = { files: [], totalSize: 0 };
  c.save(result);
  const fresh = new IndexCache(dir);
  expect(fresh.load()).toEqual(result);
  expect(typeof fresh.getBuiltAt()).toBe("number");
});

it("returns null builtAt for an envelope without the field", () => {
  writeFileSync(join(dir, "index-cache.json"), JSON.stringify({ version: 2, root: "", signature: "", result: { files: [], totalSize: 0 } }));
  const c = new IndexCache(dir);
  c.load();
  expect(c.getBuiltAt()).toBeNull();
});
```

- [ ] **Step 6: Запустить тесты**

Run: `bun test tests/indexer-module.test.ts tests/modules/indexer/cache.test.ts tests/indexer.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/indexer/cache.ts src/modules/indexer/module.ts tests/indexer-module.test.ts tests/modules/indexer/cache.test.ts
git commit -m "feat(indexer): mapInfo with builtAt, languages and watcher state"
```

---

### Task 3: Проброс в host-state / module / state

**Files:**
- Modify: `src/modules/webui/host-state.ts` (`WebIndexer`, `HostStateInput`)
- Modify: `src/modules/webui/module.ts` (`getState`, `state.refreshIndex`)
- Modify: `src/modules/webui/state.ts` (`WebUiState.refreshIndex`)
- Test: `tests/webui-usage.test.ts`

- [ ] **Step 1: Падающий тест `buildHostState` пробрасывает ProjectMapInfo**

Добавить в `tests/webui-usage.test.ts`:

```ts
it("passes a full ProjectMapInfo through to the snapshot", () => {
  const snapshot = buildHostState(
    {
      config: { model: "m", provider: { active: "p" } } as never,
      projectMap: {
        indexed: true, indexing: false, files: 3, symbols: 9, tokens: 100,
        updatedAt: 1700000000000,
        languages: [{ language: "typescript", files: 2, symbols: 8 }],
        watcher: true,
      },
    },
    false,
  );
  expect(snapshot.projectMap).toMatchObject({ updatedAt: 1700000000000, watcher: true });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `bun test tests/webui-usage.test.ts -t "ProjectMapInfo"`
Expected: FAIL типом (TS) — `projectMap` шире сигнатуры `HostStateInput`.

- [ ] **Step 3: `host-state.ts`**

Импорт: `import type { HostStateSnapshot, ProjectMapInfo } from "../../core/host";`.
В `HostStateInput` заменить строку 26:

```ts
  projectMap?: ProjectMapInfo | null;
```

Тип `WebIndexer`:

```ts
export interface WebIndexer {
  buildIndex(): Promise<unknown>;
  stats(): { files: number; symbols: number; tokens: number } | null;
  mapInfo?(): ProjectMapInfo;
  refresh?(): Promise<unknown>;
}
```

- [ ] **Step 4: `state.ts` — `refreshIndex`**

В `WebUiState` (рядом с `projectMapStats`, ~line 175):

```ts
  /** Ручной пересбор индекса карты проекта (`POST /api/index`). */
  refreshIndex?: () => Promise<void>;
```

- [ ] **Step 5: `module.ts`**

В `startWebUi` рядом со строкой 155:

```ts
  if (deps.indexer) {
    state.projectMapStats = () => deps.indexer?.stats() ?? null;
    state.refreshIndex = async () => {
      await deps.indexer?.refresh?.();
    };
  }
```

В `getState()` заменить блок `projectMap` (строки 219–222) на:

```ts
          projectMap: deps.indexer?.mapInfo?.() ?? undefined,
```

- [ ] **Step 6: Запустить тесты**

Run: `bun test tests/webui-usage.test.ts tests/webui-plan.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/webui/host-state.ts src/modules/webui/module.ts src/modules/webui/state.ts tests/webui-usage.test.ts
git commit -m "feat(webui): project the full ProjectMapInfo into host state"
```

---

### Task 4: Роут `POST /api/index`

**Files:**
- Modify: `src/modules/webui/server.ts` (таблица `API_ROUTES`)
- Test: `tests/webui-server.test.ts`

- [ ] **Step 1: Падающий тест**

Добавить в `tests/webui-server.test.ts` (используя `withServer` + `postJson` из
`./helpers/webui-server`):

```ts
it("POST /api/index triggers refreshIndex and returns 202", async () => {
  const s = createWebUiState();
  let called = 0;
  s.refreshIndex = async () => { called += 1; };
  await withServer(s, async (base) => {
    const r = await postJson(base, "/api/index");
    expect(r.status).toBe(202);
  });
  expect(called).toBe(1);
});

it("POST /api/index returns 503 when no indexer is wired", async () => {
  const s = createWebUiState();
  await withServer(s, async (base) => {
    const r = await postJson(base, "/api/index");
    expect(r.status).toBe(503);
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `bun test tests/webui-server.test.ts -t "/api/index"`
Expected: FAIL — 404.

- [ ] **Step 3: Реализация в `server.ts`**

В `API_ROUTES` добавить:

```ts
  "POST /api/index": (_req, res, s) => handleIndexPost(res, s),
```

И хендлер рядом с `handleInterruptPost`:

```ts
/** `POST /api/index` — fire-and-forget пересбор индекса; результат виден в `/api/state`. */
function handleIndexPost(res: ServerResponse, s: WebUiState): void {
  if (!s.refreshIndex) {
    sendJson(res, 503, { error: "unavailable" });
    return;
  }
  Promise.resolve(s.refreshIndex()).catch(() => {});
  sendJson(res, 202, { ok: true });
}
```

- [ ] **Step 4: Запустить тесты**

Run: `bun test tests/webui-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/webui/server.ts tests/webui-server.test.ts
git commit -m "feat(webui): POST /api/index re-index route"
```

---

### Task 5: i18n-ключи

**Files:**
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/i18n.test.ts`

- [ ] **Step 1: Добавить ключи** (рядом с `web.sidebar.env`)

en:

```json
  "web.sidebar.tab_session": "Session",
  "web.sidebar.tab_map": "Map",
  "web.sidebar.tab_trace": "Trace",
  "web.sidebar.map_status": "status",
  "web.sidebar.map_ready": "ready",
  "web.sidebar.map_indexing": "indexing…",
  "web.sidebar.map_stale": "stale",
  "web.sidebar.map_updated": "updated",
  "web.sidebar.map_never": "never",
  "web.sidebar.map_today": "today, {time}",
  "web.sidebar.map_watcher": "watcher",
  "web.sidebar.map_on": "on",
  "web.sidebar.map_off": "off",
  "web.sidebar.map_files": "files",
  "web.sidebar.map_symbols": "symbols",
  "web.sidebar.map_tokens": "tokens",
  "web.sidebar.map_root": "root",
  "web.sidebar.map_languages": "languages",
  "web.sidebar.map_reindex": "Re-index",
  "web.sidebar.map_reindexing": "re-indexing…",
  "web.sidebar.map_reindex_failed": "re-index failed",
  "web.sidebar.trace_empty": "no events yet",
  "web.sidebar.trace_turn": "turn {n}",
  "web.sidebar.trace_text": "composing… {count} chars",
  "web.sidebar.trace_plan": "plan update",
  "web.sidebar.trace_question": "question",
  "web.sidebar.detail_metadata": "metadata",
  "web.sidebar.detail_arguments": "arguments",
  "web.sidebar.detail_output": "output",
  "web.sidebar.detail_error": "error",
  "web.sidebar.detail_text": "text",
  "web.sidebar.detail_plan": "plan",
  "web.sidebar.detail_reasoning": "reasoning",
  "web.sidebar.detail_status": "status",
  "web.sidebar.detail_ok": "ok",
  "web.sidebar.detail_fail": "failed",
  "web.sidebar.detail_duration": "duration",
  "web.sidebar.detail_time": "time",
  "web.sidebar.detail_tool_call": "tool call",
  "web.sidebar.detail_session": "session",
```

ru (те же ключи):

```json
  "web.sidebar.tab_session": "Сессия",
  "web.sidebar.tab_map": "Карта",
  "web.sidebar.tab_trace": "Трассировка",
  "web.sidebar.map_status": "статус",
  "web.sidebar.map_ready": "готово",
  "web.sidebar.map_indexing": "индексация…",
  "web.sidebar.map_stale": "устарело",
  "web.sidebar.map_updated": "обновлено",
  "web.sidebar.map_never": "никогда",
  "web.sidebar.map_today": "сегодня, {time}",
  "web.sidebar.map_watcher": "вотчер",
  "web.sidebar.map_on": "вкл.",
  "web.sidebar.map_off": "выкл.",
  "web.sidebar.map_files": "файлы",
  "web.sidebar.map_symbols": "символы",
  "web.sidebar.map_tokens": "токены",
  "web.sidebar.map_root": "корень",
  "web.sidebar.map_languages": "языки",
  "web.sidebar.map_reindex": "Переиндексировать",
  "web.sidebar.map_reindexing": "переиндексация…",
  "web.sidebar.map_reindex_failed": "не удалось переиндексировать",
  "web.sidebar.trace_empty": "событий пока нет",
  "web.sidebar.trace_turn": "ход {n}",
  "web.sidebar.trace_text": "печатает… {count} симв.",
  "web.sidebar.trace_plan": "обновление плана",
  "web.sidebar.trace_question": "вопрос",
  "web.sidebar.detail_metadata": "метаданные",
  "web.sidebar.detail_arguments": "аргументы",
  "web.sidebar.detail_output": "вывод",
  "web.sidebar.detail_error": "ошибка",
  "web.sidebar.detail_text": "текст",
  "web.sidebar.detail_plan": "план",
  "web.sidebar.detail_reasoning": "размышление",
  "web.sidebar.detail_status": "статус",
  "web.sidebar.detail_ok": "ok",
  "web.sidebar.detail_fail": "ошибка",
  "web.sidebar.detail_duration": "длительность",
  "web.sidebar.detail_time": "время",
  "web.sidebar.detail_tool_call": "вызов тула",
  "web.sidebar.detail_session": "сессия",
```

- [ ] **Step 2: Тест паритета**

Run: `bun test tests/i18n.test.ts`
Expected: PASS (паритет en/ru соблюдён).

- [ ] **Step 3: Commit**

```bash
git add src/i18n/en.json src/i18n/ru.json
git commit -m "feat(i18n): sidebar tabs strings (en/ru)"
```

---

### Task 6: Разметка `index.html`

**Files:** `src/modules/webui/assets/index.html` (блок `.sb`, строки 98–113)

- [ ] **Step 1: Заменить `.sb`**

```html
  <div class="sb">
    <div class="sb-tabs" role="tablist" aria-label="sidebar">
      <button class="sb-tab" type="button" role="tab" data-tab="session" aria-selected="true" aria-controls="pane-session" title="Session">
        <span class="sb-ico" data-icon="session" aria-hidden="true"></span>
        <span class="sb-dot" aria-hidden="true"></span>
      </button>
      <button class="sb-tab" type="button" role="tab" data-tab="map" aria-selected="false" aria-controls="pane-map" title="Map">
        <span class="sb-ico" data-icon="map" aria-hidden="true"></span>
        <span class="sb-dot" data-hidden="true" aria-hidden="true"></span>
      </button>
      <button class="sb-tab" type="button" role="tab" data-tab="trace" aria-selected="false" aria-controls="pane-trace" title="Trace">
        <span class="sb-ico" data-icon="trace" aria-hidden="true"></span>
        <span class="sb-dot" aria-hidden="true"></span>
      </button>
    </div>
    <div class="sb-name" id="sbName"><span class="sb-ico" data-icon="session" aria-hidden="true"></span><span id="sbNameText">Session</span></div>

    <div class="sb-pane" id="pane-session" role="tabpanel" data-pane="session">
      <div class="sec plan-sec">
        <button class="sec-h" type="button" data-collapse aria-expanded="true"><span class="arrow">▾</span> <span id="planHeaderLabel">plan</span> <span class="n" id="planCount"></span></button>
        <div class="sec-body" id="plan"></div>
      </div>
      <div class="sec usage-sec">
        <button class="sec-h" type="button" data-collapse aria-expanded="true"><span class="arrow">▾</span> <span id="usageHeaderLabel">session · usage</span></button>
        <div class="sec-body" id="usage"></div>
      </div>
      <div class="sec env-sec">
        <button class="sec-h" type="button" data-collapse aria-expanded="true"><span class="arrow">▾</span> <span id="envHeaderLabel">environment</span></button>
        <div class="sec-body" id="env"></div>
      </div>
    </div>

    <div class="sb-pane" id="pane-map" role="tabpanel" data-pane="map" hidden>
      <div class="sec map-sec">
        <div class="sec-body" id="mapBody"></div>
      </div>
    </div>

    <div class="sb-pane" id="pane-trace" role="tabpanel" data-pane="trace" hidden>
      <div class="trace-list" id="traceList"></div>
      <div class="trc-detail" id="traceDetail" hidden>
        <div class="detail-h"><span class="g" id="detailGlyph">◇</span><span id="detailTitle"></span><button class="x linkbtn" type="button" id="detailClose">✕</button></div>
        <div class="detail-b" id="detailBody"></div>
      </div>
    </div>
  </div>
```

Иконки (`data-icon`) заполняются в `sidebar.js` через `icon()`.

- [ ] **Step 2: Commit**

```bash
git add src/modules/webui/assets/index.html
git commit -m "feat(webui): sidebar tab bar markup"
```

---

### Task 7: CSS `styles.css`

**Files:** `src/modules/webui/assets/styles.css` (заменить секцию sidebar ~730–790,
добавить перед ней новые правила)

- [ ] **Step 1: Добавить правила** (после `.sec.usage-sec`)

```css
/* ---- sidebar tabs ---- */
.sb-tabs { display: flex; gap: 6px; padding: 10px 14px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.sb-tab {
  position: relative; width: 34px; height: 34px; flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center; padding: 0;
  border: 1px solid var(--border-2); border-radius: 6px;
  background: transparent; color: var(--stab-fg); cursor: pointer; font: inherit;
}
.sb-tab:hover { color: var(--fg); background: var(--hover-bg); }
.sb-tab.on { color: var(--accent); background: var(--accent-bg); border-color: transparent; }
.sb-tab .sb-ico svg { width: 17px; height: 17px; }
.sb-tab .sb-dot {
  position: absolute; top: 4px; right: 4px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent); opacity: 0; transition: opacity .2s;
}
.sb-tab[data-indicator="live"] .sb-dot { opacity: 1; animation: sbPulse 1s ease-in-out infinite; }
.sb-tab[data-indicator="busy"] .sb-dot { opacity: 1; background: var(--accent); }
.sb-tab[data-indicator="stale"] .sb-dot { opacity: 1; background: var(--yellow); }
@keyframes sbPulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }

.sb-name {
  display: flex; align-items: center; gap: 8px; flex-shrink: 0;
  padding: 10px 16px; color: var(--fg); font-size: 12.5px; font-weight: 600;
  letter-spacing: .03em; border-bottom: 1px solid var(--border);
}
.sb-name .sb-ico svg { width: 14px; height: 14px; color: var(--accent); }

.sb-pane { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.sb-pane[hidden] { display: none; }

/* master-detail expansion */
.sb { transition: width .22s ease, min-width .22s ease; }
.sb.sb-expanded { width: 680px; min-width: 680px; }
#pane-trace { flex-direction: row; }
.sb-expanded #pane-trace { position: relative; }
.trace-list { flex: 1; min-width: 0; overflow-y: auto; padding: 6px 10px 12px; display: flex; flex-direction: column; gap: 1px; }
.trace-turn { color: var(--dim-c); font-size: 11px; margin: 8px 6px 2px; }
.trc { display: flex; gap: 8px; align-items: baseline; padding: 4px 6px; font-size: 12px; color: var(--muted); border-radius: 4px; cursor: pointer; }
.trc:hover { background: var(--hover-bg); }
.trc.sel { background: var(--accent-bg); }
.trc .g { flex: 0 0 auto; }
.trc.recon .g { color: var(--cyan); } .trc.mutate .g { color: var(--purple); }
.trc.execute .g { color: var(--accent); } .trc.meta .g { color: var(--meta); } .trc.phase .g { color: var(--think); }
.trc .lab { color: var(--fg); white-space: nowrap; }
.trc .args { color: var(--args); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.trc .t { color: var(--dim-b); margin-left: auto; flex: 0 0 auto; }
.trc.warn .g, .trc.warn .lab { color: var(--yellow); }
.trc.phase .lab { color: var(--think); }
.trc-detail { display: flex; flex-direction: column; flex: 0 0 340px; min-width: 0; border-left: 1px solid var(--border); }
.trc-detail[hidden] { display: none; }
.detail-h { display: flex; gap: 8px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); color: var(--fg); font-size: 12.5px; flex-shrink: 0; }
.detail-h .g { color: var(--accent); }
.detail-h .x { margin-left: auto; color: var(--dim-b); cursor: pointer; }
.detail-b { padding: 10px 14px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
.detail-b h5 { margin: 0 0 4px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--sec-h); font-weight: 600; }
.map-sec { flex: 1 1 auto; }
.map-reindex { margin-top: 10px; font: inherit; font-size: 12px; color: var(--accent); background: transparent; border: 1px solid var(--border-2); border-radius: 5px; padding: 4px 10px; cursor: pointer; width: fit-content; }
.map-reindex:disabled { color: var(--dim-b); cursor: default; }
```

- [ ] **Step 2: Скрыть Trace на мобильных**

В существующий `@media (max-width: 760px)` блок добавить:

```css
  .sb-tab[data-tab="trace"], #pane-trace { display: none; }
```

- [ ] **Step 3: Commit**

```bash
git add src/modules/webui/assets/styles.css
git commit -m "feat(webui): sidebar tabs and trace master-detail styles"
```

---

### Task 8: Модуль `js/sidebar.js`

**Files:** Create `src/modules/webui/assets/js/sidebar.js`

- [ ] **Step 1: Написать модуль**

```js
// Sidebar tabs (Session / Map / Trace) for `mma web`.
//
// Owns: active-tab state (localStorage), the live per-session Trace buffer with
// master-detail expansion, and the Map tab rendering. Leaf module: imports only
// dom/i18n/format — the frontend DAG stays acyclic (app → sidebar → {dom,i18n,format}).
// Design: docs/specs/2026-09-30-webui-sidebar-tabs-design.md.

import { el, icon } from "./dom.js";
import { api } from "./api.js";
import { S } from "./store.js";
import { t } from "./i18n.js";
import { labelOf, categoryOf, argText, formatMs } from "./format.js";

const TAB_KEY = "mma-sidebar-tab";
const TABS = ["session", "map", "trace"];
const ICON_NAME = { session: "list-checks", map: "map", trace: "activity" };
const TRACE_CAP = 500;
const MAX_OUTPUT_CHARS = 20000;

let sbEl = null, nameEl = null, nameTextEl = null, mapEl = null, listEl = null, detailEl = null;
let detailGlyph = null, detailTitle = null, detailBody = null, detailClose = null;
let active = "session";
let trace = [];          // { id, kind, ts, name, args, output, success, durationMs, phase, text, steps, currentIndex }
let selected = null;     // trace id
let turn = 0;
let seq = 0;
let pendingArgs = new Map();  // toolCallId → args (tool_start before tool_end)
let textEntry = null;         // current text row (updated in place)

function paneEl(id) { return document.getElementById("pane-" + id); }

function mqMobile() {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(max-width: 760px)").matches : false;
}

function readStored() {
  try { return localStorage.getItem(TAB_KEY); } catch { return null; }
}
function storeTab(id) {
  try { localStorage.setItem(TAB_KEY, id); } catch { /* private mode */ }
}

export function setSidebarTab(id) {
  if (!TABS.includes(id)) id = "session";
  if (id === "trace" && mqMobile()) id = "session";
  active = id;
  storeTab(id);
  TABS.forEach((name) => {
    const pane = paneEl(name);
    if (pane) pane.hidden = name !== id;
    const tab = sbEl && sbEl.querySelector('.sb-tab[data-tab="' + name + '"]');
    if (tab) {
      const on = name === id;
      tab.classList.toggle("on", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    }
  });
  if (nameTextEl) nameTextEl.textContent = t("web.sidebar.tab_" + id);
  const nic = nameEl && nameEl.querySelector(".sb-ico");
  if (nic) { nic.textContent = ""; nic.appendChild(icon(ICON_NAME[id])); }
  const nameIcon = nameEl && nameEl.querySelector(".sb-ico");
  if (nameIcon) nameIcon.dataset.icon = id;
}

function collapseDetail() {
  selected = null;
  if (sbEl) sbEl.classList.remove("sb-expanded");
  if (detailEl) detailEl.hidden = true;
  if (listEl) listEl.querySelectorAll(".trc.sel").forEach((n) => n.classList.remove("sel"));
}

function catClass(kind, name) {
  if (kind === "tool" || kind === "tool_fail") return categoryOf(name);
  if (kind === "phase") return "phase";
  return "meta";
}

function rowLabel(entry) {
  switch (entry.kind) {
    case "phase": return t("web.action.thinking");
    case "plan": return t("web.sidebar.trace_plan");
    case "question": return t("web.sidebar.trace_question");
    case "text": return t("web.sidebar.trace_text", { count: entry.text.length });
    default: return labelOf(entry.name);
  }
}

function rowArgs(entry) {
  if (entry.kind === "text") return "";
  if (entry.kind === "phase") return entry.phase;
  if (entry.kind === "plan") {
    const idx = typeof entry.currentIndex === "number" ? entry.currentIndex : 0;
    return t("web.rail.step_of", { cur: Math.min(idx + 1, entry.steps.length), total: entry.steps.length });
  }
  if (entry.kind === "question") return entry.text || "";
  return argText(entry.args);
}

function isWarn(entry) {
  return entry.kind === "tool_fail" || entry.kind === "error";
}

function renderRow(entry) {
  const cls = ["trc", catClass(entry.kind, entry.name)];
  if (isWarn(entry)) cls.push("warn");
  if (selected === entry.id) cls.push("sel");
  const row = el("div", cls.filter(Boolean).join(" "));
  row.dataset.id = String(entry.id);
  row.appendChild(el("span", "g", isWarn(entry) ? "⚠" : entry.kind === "question" ? "?" : "◇"));
  row.appendChild(el("span", "lab", rowLabel(entry)));
  const args = rowArgs(entry);
  if (args) row.appendChild(el("span", "args", args));
  if (entry.durationMs) row.appendChild(el("span", "t", formatMs(entry.durationMs)));
  row.addEventListener("click", () => {
    if (selected === entry.id) { collapseDetail(); return; }
    selected = entry.id;
    renderList();
    renderDetail(entry);
    if (sbEl) sbEl.classList.add("sb-expanded");
  });
  return row;
}

function renderList() {
  if (!listEl) return;
  listEl.textContent = "";
  if (trace.length === 0) {
    listEl.appendChild(el("div", "trace-turn", t("web.sidebar.trace_empty")));
    return;
  }
  let shownTurn = 0;
  for (const entry of trace) {
    if (entry.turn !== shownTurn) {
      shownTurn = entry.turn;
      listEl.appendChild(el("div", "trace-turn", t("web.sidebar.trace_turn", { n: entry.turn })));
    }
    listEl.appendChild(renderRow(entry));
  }
  listEl.scrollTop = listEl.scrollHeight;
}

function append(entry) {
  entry.id = ++seq;
  entry.turn = turn;
  entry.ts = Date.now();
  trace.push(entry);
  if (trace.length > TRACE_CAP) trace.splice(0, trace.length - TRACE_CAP);
}

function pushRow(entry) {
  if (!listEl) return;
  if (entry.turn !== (listEl.dataset.lastTurn ? Number(listEl.dataset.lastTurn) : 0)) {
    listEl.appendChild(el("div", "trace-turn", t("web.sidebar.trace_turn", { n: entry.turn })));
    listEl.dataset.lastTurn = String(entry.turn);
  }
  listEl.appendChild(renderRow(entry));
  listEl.scrollTop = listEl.scrollHeight;
}

function updateTextRow(entry) {
  const row = listEl && listEl.querySelector('.trc[data-id="' + entry.id + '"]');
  if (!row) return;
  row.textContent = "";
  row.appendChild(el("span", "g", "✦"));
  row.appendChild(el("span", "lab", rowLabel(entry)));
  listEl.scrollTop = listEl.scrollHeight;
}

// ---- public API ----

export function sidebarSessionChanged(sid) {
  const prev = sbEl && sbEl.dataset.sid;
  if (prev === sid) return;
  if (sbEl) sbEl.dataset.sid = sid || "";
  trace = [];
  textEntry = null;
  turn = 0;
  seq = 0;
  collapseDetail();
  renderList();
}

export function sidebarTurnEnd() {
  turn += 1;
  textEntry = null;
}

export function sidebarTraceEvent(kind, data) {
  if (!data) return;
  switch (kind) {
    case "tool_start":
      pendingArgs.set(data.toolCallId, data.args || {});
      append({ kind: "tool", name: data.name, args: data.args || {} });
      pushRow(trace[trace.length - 1]);
      break;
    case "tool_end": {
      const args = pendingArgs.get(data.toolCallId) || {};
      pendingArgs.delete(data.toolCallId);
      append({
        kind: data.success === false ? "tool_fail" : "tool",
        name: data.name, args, success: data.success !== false,
        durationMs: data.durationMs, output: data.output || "",
      });
      pushRow(trace[trace.length - 1]);
      break;
    }
    case "phase":
      append({ kind: "phase", phase: data.phase });
      pushRow(trace[trace.length - 1]);
      break;
    case "plan":
      append({
        kind: "plan",
        steps: Array.isArray(data.steps) ? data.steps : [],
        currentIndex: typeof data.currentIndex === "number" ? data.currentIndex : 0,
      });
      pushRow(trace[trace.length - 1]);
      break;
    case "question":
      append({ kind: "question", text: data.question || data.text || "" });
      pushRow(trace[trace.length - 1]);
      break;
    case "text": {
      if (!textEntry) { append({ kind: "text", text: "" }); textEntry = trace[trace.length - 1]; pushRow(textEntry); }
      textEntry.text += data.chunk || "";
      if (textEntry.text.length > 4000) textEntry.text = textEntry.text.slice(-4000);
      updateTextRow(textEntry);
      break;
    }
    case "error":
      append({ kind: "error", message: data.message || data.error || "" });
      pushRow(trace[trace.length - 1]);
      break;
    default:
      break;
  }
}

function detailGroup(title, bodyNode) {
  const g = el("div");
  g.appendChild(el("h5", "", title));
  g.appendChild(bodyNode);
  return g;
}
function kv(label, value) {
  const row = el("div", "kv");
  row.appendChild(el("span", "dim", label));
  const b = el("b");
  b.textContent = value;
  row.appendChild(b);
  return row;
}
function codeBlock(text) {
  const c = el("div", "code");
  c.textContent = text;
  return c;
}

function renderDetail(entry) {
  if (!detailEl) return;
  detailEl.hidden = false;
  const warn = isWarn(entry);
  detailGlyph.textContent = warn ? "⚠" : entry.kind === "question" ? "?" : "◇";
  detailGlyph.style.color = warn ? "var(--yellow)" : "var(--accent)";
  detailTitle.textContent = rowLabel(entry);
  detailBody.textContent = "";

  const meta = el("div");
  meta.appendChild(el("h5", "", t("web.sidebar.detail_metadata")));
  const d = entry.ts ? new Date(entry.ts) : null;
  if (entry.kind.startsWith("tool")) {
    meta.appendChild(kv(t("web.sidebar.detail_status"), entry.success === false ? t("web.sidebar.detail_fail") : t("web.sidebar.detail_ok")));
    if (entry.durationMs) meta.appendChild(kv(t("web.sidebar.detail_duration"), formatMs(entry.durationMs)));
  }
  if (d) meta.appendChild(kv(t("web.sidebar.detail_time"), d.toLocaleTimeString()));
  if (entry.toolCallId) meta.appendChild(kv(t("web.sidebar.detail_tool_call"), String(entry.toolCallId)));
  if (sbEl && sbEl.dataset.sid) meta.appendChild(kv(t("web.sidebar.detail_session"), sbEl.dataset.sid));
  detailBody.appendChild(meta);

  if (entry.kind.startsWith("tool")) {
    detailBody.appendChild(detailGroup(t("web.sidebar.detail_arguments"), codeBlock(JSON.stringify(entry.args || {}, null, 2))));
    detailBody.appendChild(detailGroup(t("web.sidebar.detail_output"), codeBlock((entry.output || "").slice(0, MAX_OUTPUT_CHARS))));
  } else if (entry.kind === "text") {
    detailBody.appendChild(detailGroup(t("web.sidebar.detail_text"), codeBlock(entry.text || "")));
  } else if (entry.kind === "plan") {
    const list = el("div");
    (entry.steps || []).forEach((s) => {
      const mark = s.status === "done" ? "✓" : s.status === "failed" ? "✗" : s.status === "in_progress" ? "▸" : "○";
      list.appendChild(el("div", "plan-step " + (s.status === "failed" ? "fail" : s.status === "in_progress" ? "cur" : s.status === "done" ? "done" : ""), mark + " " + s.text));
    });
    detailBody.appendChild(detailGroup(t("web.sidebar.detail_plan"), list));
  } else if (entry.kind === "question") {
    detailBody.appendChild(detailGroup(t("web.sidebar.trace_question"), codeBlock(entry.text || "")));
  } else if (entry.kind === "error") {
    detailBody.appendChild(detailGroup(t("web.sidebar.detail_error"), codeBlock(entry.message || "")));
  }
}

// ---- Map tab ----

function fmtUpdated(updatedAt) {
  if (typeof updatedAt !== "number") return t("web.sidebar.map_never");
  const d = new Date(updatedAt);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toTimeString().slice(0, 5);
  return sameDay ? t("web.sidebar.map_today", { time }) : d.toLocaleString();
}

function mapKv(label, value, cls) {
  const row = el("div", "kv" + (cls ? " " + cls : ""));
  row.appendChild(el("span", "dim", label));
  const b = el("b");
  b.textContent = value;
  row.appendChild(b);
  return row;
}

let reindexing = false;   // клиентский спиннер до свежего снапшота
let postResolved = false; // POST вернулся; следующий снапшот снимет спиннер
let reindexError = false; // последний POST не удался

export function sidebarMapState(host) {
  if (!mapEl) return;
  const map = (host && host.projectMap) || null;
  const serverIndexing = !!(map && map.indexing);
  if (postResolved && !serverIndexing) { reindexing = false; postResolved = false; }
  const indexing = serverIndexing || reindexing;
  mapEl.textContent = "";
  if (!map) {
    mapEl.appendChild(mapKv(t("web.sidebar.map_status"), t("web.sidebar.map_never")));
    return;
  }
  const status = indexing ? t("web.sidebar.map_indexing")
    : !map.indexed ? t("web.sidebar.map_never")
    : (map.watcher ? t("web.sidebar.map_ready") : t("web.sidebar.map_stale"));
  mapEl.appendChild(mapKv(t("web.sidebar.map_status"), status));
  mapEl.appendChild(mapKv(t("web.sidebar.map_updated"), fmtUpdated(map.updatedAt)));
  mapEl.appendChild(mapKv(t("web.sidebar.map_watcher"), map.watcher ? t("web.sidebar.map_on") : t("web.sidebar.map_off")));
  mapEl.appendChild(mapKv(t("web.sidebar.map_files"), String(map.files || 0)));
  mapEl.appendChild(mapKv(t("web.sidebar.map_symbols"), String(map.symbols || 0)));
  mapEl.appendChild(mapKv(t("web.sidebar.map_tokens"), fmtTokens(map.tokens)));
  if (host && host.workspace) mapEl.appendChild(mapKv(t("web.sidebar.map_root"), host.workspace));

  if (Array.isArray(map.languages) && map.languages.length > 0) {
    const head = el("div", "kv");
    head.appendChild(el("span", "dim", t("web.sidebar.map_languages")));
    mapEl.appendChild(head);
    map.languages.forEach((l) => mapEl.appendChild(mapKv(l.language, l.files + " · " + l.symbols)));
  }
  if (reindexError) mapEl.appendChild(mapKv(t("web.sidebar.map_reindex_failed"), "—", "wn"));

  const btn = el("button", "map-reindex", indexing ? t("web.sidebar.map_reindexing") : t("web.sidebar.map_reindex"));
  btn.type = "button";
  btn.disabled = indexing;
  btn.addEventListener("click", async () => {
    reindexing = true;
    postResolved = false;
    reindexError = false;
    sidebarMapState(host);
    const r = await api("/api/index", { method: "POST" });
    if (!r.ok) {
      reindexing = false;
      postResolved = false;
      reindexError = true;
      sidebarMapState(host);
      return;
    }
    // Свежий снапшот (поллинг / `state`-broadcast по завершении) снимет спиннер.
    postResolved = true;
  });
  mapEl.appendChild(btn);
}

function fmtTokens(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n || 0);
}

// ---- indicators ----

export function sidebarBusy(on) {
  const tab = sbEl && sbEl.querySelector('.sb-tab[data-tab="trace"]');
  if (tab) tab.dataset.indicator = on ? "live" : "";
}
export function sidebarMapIndicator(host) {
  const tab = sbEl && sbEl.querySelector('.sb-tab[data-tab="map"]');
  if (!tab) return;
  const map = (host && host.projectMap) || null;
  tab.dataset.indicator = map && map.indexing ? "busy" : map && map.indexed && !map.watcher ? "stale" : "";
}

// ---- init / i18n ----

export function applySidebarI18n() {
  if (!sbEl) return;
  TABS.forEach((id) => {
    const tab = sbEl.querySelector('.sb-tab[data-tab="' + id + '"]');
    if (tab) { const label = t("web.sidebar.tab_" + id); tab.title = label; tab.setAttribute("aria-label", label); }
  });
  setSidebarTab(active);
  renderList();
  if (selected) {
    const entry = trace.find((x) => x.id === selected);
    if (entry) renderDetail(entry);
  }
  sidebarMapState(S.state.host);
}

export function initSidebar() {
  sbEl = document.querySelector(".sb");
  if (!sbEl) return;
  nameEl = document.getElementById("sbName");
  nameTextEl = document.getElementById("sbNameText");
  mapEl = document.getElementById("mapBody");
  listEl = document.getElementById("traceList");
  detailEl = document.getElementById("traceDetail");
  detailGlyph = document.getElementById("detailGlyph");
  detailTitle = document.getElementById("detailTitle");
  detailBody = document.getElementById("detailBody");
  detailClose = document.getElementById("detailClose");
  if (detailClose) detailClose.addEventListener("click", collapseDetail);

  // Fill tab icons.
  sbEl.querySelectorAll(".sb-tab .sb-ico").forEach((span) => {
    const id = span.closest(".sb-tab").dataset.tab;
    span.textContent = "";
    span.appendChild(icon(ICON_NAME[id]));
  });

  // Tab clicks.
  sbEl.querySelectorAll(".sb-tab").forEach((tab) => {
    tab.addEventListener("click", () => setSidebarTab(tab.dataset.tab));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const i = TABS.indexOf(tab.dataset.tab);
      const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
      setSidebarTab(next);
      const el2 = sbEl.querySelector('.sb-tab[data-tab="' + next + '"]');
      if (el2) el2.focus();
    });
  });

  // Hotkeys Alt+1/2/3.
  document.addEventListener("keydown", (e) => {
    if (!e.altKey || !["1", "2", "3"].includes(e.key)) return;
    const tag = document.activeElement ? String(document.activeElement.tagName) : "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault();
    setSidebarTab(TABS[Number(e.key) - 1]);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && selected) collapseDetail();
  });

  const stored = readStored();
  setSidebarTab(stored && TABS.includes(stored) ? stored : "session");
  renderList();
}
```

(Публичный `sidebarBusy`/`sidebarMapIndicator` вызываются из `app.js`.)

- [ ] **Step 2: Commit**

```bash
git add src/modules/webui/assets/js/sidebar.js
git commit -m "feat(webui): sidebar tabs module (trace + map)"
```

---

### Task 9: Wiring в `app.js`

**Files:** `src/modules/webui/assets/app.js`

- [ ] **Step 1: Импорт**

После импорта rail (строки 19–21):

```js
import {
  initSidebar, setSidebarTab, sidebarSessionChanged, sidebarMapState,
  sidebarTraceEvent, sidebarTurnEnd, sidebarBusy, sidebarMapIndicator,
  applySidebarI18n,
} from "./js/sidebar.js";
```

- [ ] **Step 2: `renderState` — Map + сессия + индикаторы**

В `renderState` (после `renderEnvironment`, строка 79):

```js
  sidebarMapState(S.state.host);
  sidebarMapIndicator(S.state.host);
  sidebarSessionChanged(sessionId);
```

- [ ] **Step 3: SSE-подписка Trace**

После rail-цикла (строки 143–151):

```js
// Sidebar Trace: live per-session event log. Feed handlers stay untouched.
for (const ev of ["tool_start", "tool_end", "phase", "plan", "question"]) {
  es.addEventListener(ev, (e) => { const d = parse(e); if (d) sidebarTraceEvent(ev, d); });
}
es.addEventListener("text", (e) => { const d = parse(e); if (d) sidebarTraceEvent("text", d); });
```

В bespoke `state`-хендлере (строка 156) после `reflectBusy()` добавить
`sidebarBusy(!!d.busy);` и `refresh();` — завершающий `state`-broadcast от
`POST /api/index` не несёт `projectMap`, поэтому перетягиваем свежий `/api/state`
(там `renderState` дёрнет `sidebarMapState`/`sidebarMapIndicator`).
В `turn_end`-хендлере: обернуть `onTurnEnd` — в таблице
`handlers` заменить `["turn_end", onTurnEnd],` на:

```js
  ["turn_end", (d) => { onTurnEnd(d); sidebarTurnEnd(); sidebarBusy(false); }],
```

В bespoke `error`-хендлере (строки 167–171): внутри `if (d)` добавить
`sidebarTraceEvent("error", d);`.

- [ ] **Step 4: i18n-хук и boot**

В `applyStaticI18n()` после `applyRailI18n();` (строка 241) добавить
`applySidebarI18n();`.

В `boot()` после `initRail(...)` (строка 267) добавить:

```js
  initSidebar();
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/webui/assets/app.js
git commit -m "feat(webui): wire sidebar tabs into app boot and SSE"
```

---

### Task 10: Source-guard тесты ассетов

**Files:** `tests/webui-assets.test.ts`

- [ ] **Step 1: Добавить тест**

```ts
it("wires the sidebar tabs (session / map / trace) with master-detail", () => {
  const a = loadAssets();
  const src = js(a);
  expect(a.html).toContain('class="sb-tabs"');
  expect(a.html).toContain('data-tab="session"');
  expect(a.html).toContain('data-tab="map"');
  expect(a.html).toContain('data-tab="trace"');
  expect(a.html).toContain('id="sbNameText"');
  expect(a.html).toContain('id="traceList"');
  expect(a.html).toContain('id="traceDetail"');
  expect(a.html).toContain('id="mapBody"');
  expect(a.css).toContain(".sb-tab.on");
  expect(a.css).toContain(".sb.sb-expanded");
  expect(a.css).toContain(".trc-detail");
  expect(src).toContain("initSidebar(");
  expect(src).toContain("sidebarTraceEvent(");
  expect(src).toContain("sidebarMapState(");
  expect(src).toContain("/api/index");
  expect(a.jsModules?.["js/sidebar.js"]).toBeTruthy();
});
```

- [ ] **Step 2: Запустить**

Run: `bun test tests/webui-assets.test.ts tests/i18n.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/webui-assets.test.ts
git commit -m "test(webui): sidebar tabs source guards"
```

---

### Task 11: Документация, версия, финальная проверка

**Files:**
- Modify: `package.json` (version)
- Modify: `CHANGELOG.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Версия**

`package.json`: `"version": "2.13.0"` (MINOR: новая UI-фича + новый роут + config-less).

- [ ] **Step 2: CHANGELOG**

Добавить наверху:

```markdown
## [2.13.0] - 2026-09-30

### Added
- **Web UI**: sidebar tabs — Session / Map / Trace. Square icon tabs with the
  active tab name shown below them (`assets/js/sidebar.js`, `index.html`, `styles.css`).
- **Map tab**: project-map index state — status, last-updated timestamp, watcher,
  files/symbols/tokens, root, per-language breakdown, and a Re-index button
  (`POST /api/index`). `IndexerModule.mapInfo()` + `ProjectMapInfo` host contract.
- **Trace tab**: live per-session log of tool calls, phases, plan updates, errors,
  questions and the answer text stream; click opens a detail panel (full args,
  output, metadata) and doubles the sidebar width.
- **i18n**: `web.sidebar.tab_*`, `web.sidebar.map_*`, `web.sidebar.trace_*`,
  `web.sidebar.detail_*` (en + ru).
```

- [ ] **Step 3: AGENTS.md**

Добавить раздел «Web Sidebar Tabs (2.13.0)» с описанием вкладок, `projectMap`
расширения, `POST /api/index`, `js/sidebar.js` и mobile-скрытия Trace.

- [ ] **Step 4: Полный прогон**

Run: `bun test && tsc --noEmit && bun run lint`
Expected: всё зелёное. Затем `bun run quality` (typecheck + lint + fallow).

- [ ] **Step 5: Commit**

```bash
git add package.json CHANGELOG.md AGENTS.md
git commit -m "docs: sidebar tabs changelog, AGENTS and 2.13.0 version"
```

---

## Ручная проверка

1. `bun run web:dev` → открыть UI.
2. Сверху сайдбара три квадратные иконки; под ними имя активной вкладки.
3. Session — без регрессий (plan/usage/environment, сворачивание секций).
4. Map — статус/время/вотчер/счётчики/языки/корень; «Re-index» → статус
   `индексация…` и обновление `updated`.
5. Trace — запустить задачу с тулами: строки появляются живьём, текст одной
   обновляющейся строкой, план/ошибки/вопрос видны; клик по строке расширяет
   сайдбар вдвое и показывает детали; `Esc`/`✕` сворачивают.
6. `Alt+1/2/3` переключают вкладки; после перезагрузки активна последняя.
7. Узкое окно (≤760px): Trace-вкладки нет; Session/Map работают в drawer.
8. `Ctrl+F5` — stale-ассеты не мешают (`Cache-Control: no-store`).
