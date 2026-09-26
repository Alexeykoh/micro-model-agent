# Web UI decompose + dedup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

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

## Phase 2: `module.ts` — разрезать god-function

**Files:** Modify `src/modules/webui/module.ts` (388 → ≤300); New `model-cache.ts`, `run-agent.ts` (или секции внутри `module.ts` как чистые функции).

- [ ] **Step 1: вынести model-cache**
  `refreshModels` + `modelCache` → `makeModelCache(deps)` с `get/refresh`. `module.ts` только wires.
- [ ] **Step 2: вынести `makeRunAgent`**
  `runAgent` (tool id matching, usage capture, broadcast) → отдельная фабрика с deps `{agent, execModule, forwarder, state}`. Чистые `callFor/resultFor/startId/endId` — рядом.
- [ ] **Step 3: вынести `makeHost`**
  Сборка `WebHost` + `getState` projection — отдельно, `buildHostState` уже чистый.

Run: `bun test tests/web-host.test.ts tests/webui-smoke.test.ts` + `tsc --noEmit`.

---

## Phase 3: Фронт — ES-модули (по одному шагу, каждый грузится и работает)

Порядок — от независимого к связанному; после каждого шага страница открывается (`bun run web:dev`, e2e smoke).

- [ ] **Step 1: `js/api.js` + `js/dom.js` (`el`, `icon`, `link`)**
  Вынести `api()`, `el/icon/setIcon/link/activate` как есть. `app.js` импортит. Проверка: страница грузится, feed рендерится.
- [ ] **Step 2: `js/state.js` + `js/i18n.js` (`t`, `pluralCount`, `loadI18n`)**
  `state`, `tabs`-метаданные позже; сейчас только глобальный store + словарь.
- [ ] **Step 3: `js/feed.js`**
  `onText/onReasoning/onMeta/onPhase/onToolStart/onToolEnd/onTurnEnd/onCritic/onLog/onCommandOutput` + `renderHistory*`. Самый большой кусок (~600 строк) — выносить целиком, не рефакторя.
- [ ] **Step 4: `js/tabs.js` + `js/composer.js` (send/attach/cmdk)**
- [ ] **Step 5: `js/settings/*` (generic/model-providers/memory/skills/plugins/security/ui)**
- [ ] **Step 6: `js/dialog.js` (settings/provider/confirm overlay) — объединить focus-trap**
- [ ] **Step 7: `app.js` = только `boot()` + wiring; `index.html` грузит модули**

Run после каждого: `bun run web:dev` вручную + `bun run test:e2e` (harness). E2E `web-provider-dialog` — регресс диалогов.

---

## Phase 4: Фронт — дедуп (только после Phase 3, когда модули изолированы)

- [ ] **Step 1: один `planGlyph(status)` + `planRow(step)`** — вместо `renderPlan`/`onPlan` копий
- [ ] **Step 2: один `makeToggle(value, onChange)`** — settings/MCP/enum
- [ ] **Step 3: один `trapFocus(overlay)` + `openDialog/closeDialog`** — три оверлея
- [ ] **Step 4: очередь `toast()`** — вместо затирающих `setIndicator` из 15 мест
- [ ] **Step 5: `HELP` команды → ключи i18n** (backend `commands.ts`)

---

## Phase 5: `styles.css` (1047 строк) + мелочи (в скоупе)

- [ ] Разбить по секциям комментариями (feed/composer/settings/dialogs), без смены стилей
- [ ] Мелочи: `MAX_CLIENTS` в `createWebUiState()`; `catch` в `handleProvidersDelete`; `HELP` в `commands.ts` → ключи i18n

---

## Verification (после каждой Phase)

1. `bun test` — 0 fail (база: 2602 pass 2026-09-26)
2. `bunx tsc --noEmit` — чисто
3. `bun run quality` — без новых lint-предупреждений
4. `bun run test:e2e` — зелёный (только по явной команде, Playwright)
5. Каждый файл `src/modules/webui/*.ts` ≤300 строк; `app.js` тает по фазам (цель ≤300 к концу Phase 3)

## Не трогаем

`forward.ts`, `state.ts` (busy-токены), `prompt-io.ts`, `answer-api.ts`, `history-api.ts`, `file-api.ts`, `log-forward.ts`, `md.js/smd.js/hljs.js/setup.js` — аудит претензий к ним не выявил.
