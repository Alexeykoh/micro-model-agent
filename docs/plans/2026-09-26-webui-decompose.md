# Web UI decompose + dedup — Implementation Plan

> **Статус:** исполнено (2026-10-20) — фазы 1–5 выполнены: `API_ROUTES`/`API_GROUPS`,
> единый `persistAndReconfigure`, `module.ts` ≤300 строк, фронт разбит, дедуп хелперов.
> Чекбоксы проставлены по факту. Отклонение: `routes.ts`/`body.ts`/`persist.ts` лежат
> в `src/modules/webui/http/` (переезд при модуляризации) — функционально то же.

**Goal:** Убрать главные нарушения из аудита 2026-09-26 без смены поведения: разбить `assets/app.js` (3462 строки / ~163 функции в одном IIFE) на ES-модули, привести `module.ts` (388), `providers-api.ts` (352), `server.ts` (326) к лимиту ≤300 строк, удалить дубли (`persistAndReconfigure`, `JSON.parse` ×8, глифы плана, toggle, focus-trap).

**Architecture:** Фронт делится на ES-модули без бандлера (`app.js` уже ESM через `md.js`); бэк — единая таблица роутов вместо `if`-лесенки и один `parseJsonBody` + один `persistAndReconfigure`. Каждый шаг — поведение сохраняется, тесты остаются зелёными.

**Tech Stack:** Bun + TypeScript, vitest (`bun test`), Node `http`, ванильный JS (ESM) в `assets/`, i18n `t()`, e2e-харнес `tests/e2e/web-harness.ts`.

**Spec:** аудит — этот чат 2026-09-26 (инвентарь: `src/modules/webui/*`, `src/core/web-host.ts`, `assets/*`). Changelog — подвести итог в Unreleased по факту.

**Branch:** `refactor/webui-decompose` (от `master` после мержа `chore/web-e2e-harness`).

**Решения (2026-09-26):** работаем параллельно (backend + фронт независимыми шагами); фронт — крупные модули (5-7 файлов); CSS разбиваем секциями + заодно мелкие фиксы (`MAX_CLIENTS`, `catch` в delete, i18n для `HELP`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/modules/webui/server.ts` | только транспорт: `handleRequest`, SSE, статика; роуты — таблицей |
| `src/modules/webui/routes.ts` (new) | `ROUTES: Record<method+path, handler>` + диспетчер |
| `src/modules/webui/body.ts` (new) | `parseJsonBody(req)` — один JSON-парсинг на все POST |
| `src/modules/webui/persist.ts` (new) | один `persistAndReconfigure(s, cfg)` |
| `src/modules/webui/module.ts` | только wiring: `wireState / initModelCache / makeRunAgent / makeHost` |
| `src/modules/webui/assets/js/*.js` (new) | крупные модули: `api.js` (+dom-хелперы), `state.js` (+i18n), `feed.js`, `tabs.js` (+composer), `settings.js`, `dialog.js` |
| `src/modules/webui/assets/app.js` | только `boot()` |
| tests | существующие `webui-*` + `e2e/web-harness` как регресс |

---

## Phase 1: Backend — роутер и дедуп (без фронта)

**Files:** Modify `server.ts`, `util.ts`, `config-api.ts`, `providers-api.ts`, `sessions-api.ts`, `settings-api.ts`; New `routes.ts`, `body.ts`, `persist.ts`.

- [x] **Step 1: `parseJsonBody` в `body.ts` + тесты** (done: `body.ts` + `tests/webui-body.test.ts`)
- [x] **Step 2: заменить 12 мест ручного `JSON.parse`** (done: answer/config/providers/sessions×2/settings×2/setup×4/server-command)
- [x] **Step 3: единый `persistAndReconfigure`** (done: `persist.ts`, используют config/providers/setup)
- [x] **Step 4: таблица роутов в `server.ts`** (done: `API_ROUTES` + `API_GROUPS`, `handleCommandPost`/`handleInterruptPost` вынесены; server 326→293)
- [x] **Step 5: мелочи** (done: `maxClients` в `createWebUiState()`; `catch` в delete; сверх плана: view-слой → `providers-view.ts`, providers-api 352→251)

Run: `bun test tests/webui-*.test.ts` + `bunx tsc --noEmit`. Каждый файл ≤300 строк.

---

## Phase 2: `module.ts` — разрезать god-function (done)

`module.ts` 407→253; новые `host-state.ts` (снапшот+usage+plan), `run-agent.ts` (турн-раннер), `model-cache.ts`. Тестовые импорты сохранены через реэкспорты.

---

## Phase 3: Фронт — ES-модули (done)

Итог: `app.js` 3462→265 (shell: boot/SSE/renderState/i18n); новые `js/dom.js`, `js/api.js`,
`js/i18n.js`, `js/store.js` (S + hooks), `js/format.js` (+contextLabel), `js/feed.js` (~980:
стрим/карточки/история/сайдбар), `js/tabs.js` (~670: табы/сессии/композер/лоадеры),
`js/settings.js` (~1150: панели/провайдеры/postConfig/оверлеи/тема — оставлен целым
сознательно: разрез панелей дал бы цикл settings↔panels), `js/dialog.js` (тост+confirm).
DAG ацикличен: app → settings → tabs → {feed, dialog}; feed → {dom, api, i18n, store,
format}; settings → {tabs (closeAllMenus/setSessOpen), dialog}. Связь locale — хук
`S.hooks.applyStaticI18n`. Сервер отдаёт `/js/*` (`jsModules` в ассетах).
Проверки каждого шага: `node --check`, `tsc --checkJs` (TS2304), обход import-графа
через живой сервер, `bun test tests/webui-*`.

---

## Phase 4: Фронт — дедуп (done)

- [x] `planStepMark(step, isCurrent)` в `feed.js` — вместо копий в `renderPlan`/`onPlan`
- [x] `makeToggle(on, onFlip)` в `dom.js` — bool-контрол + MCP-переключатель
- [x] `trapTab(container, e)` в `dialog.js` — settings- и provider-оверлеи (confirm оставил свой двухкнопочный вариант сознательно)
- [x] очередь тостов в `setIndicator` (`dialog.js`, cap 3) — вместо затирания
- [x] `HELP` → ключи `web.command.*` (en+ru), `webCommandList`/`/help` резолвят через `t()`

---

## Phase 5: `styles.css` + мелочи (done)

- [x] Верхнеуровневые баннеры секций (токены/topbar/чат/композер/сайдбар/модалка) — только комментарии, стили не тронуты (файл и так комментирован построчно)
- [x] Мелочи: `maxClients` в `createWebUiState()`; `catch` в `handleProvidersDelete`; `HELP` → i18n (см. Phase 4)

---

## Verification (после каждой Phase)

1. `bun test` — 0 fail (база: 2602 pass 2026-09-26)
2. `bunx tsc --noEmit` — чисто
3. `bun run quality` — без новых lint-предупреждений
4. `bun run test:e2e` — зелёный (только по явной команде, Playwright)
5. Каждый файл `src/modules/webui/*.ts` ≤300 строк; `app.js` тает по фазам (цель ≤300 к концу Phase 3)

## Не трогаем

`forward.ts`, `state.ts` (busy-токены), `prompt-io.ts`, `answer-api.ts`, `history-api.ts`, `file-api.ts`, `log-forward.ts`, `md.js/smd.js/hljs.js/setup.js` — аудит претензий к ним не выявил.
