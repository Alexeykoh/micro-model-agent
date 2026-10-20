# Web Session State & Per-Tab Projection — Implementation Plan

> **Статус:** исполнено (2026-10-20) — план исполнен: `GET /api/state`, клиентский
> `applyState`, loading-индикаторы, персист per-session usage. Phase 3 (per-session
> SSE-подписки) откачен намеренно и зафиксирован в плане; legacy-путь снят (остался guard
> `hasFactory()`). Чекбоксы проставлены по факту.

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) or

**Goal:** Сайдбар `mma web` следует за активной вкладкой клиента, обновляется
мгновенно и полно, без гонок и чужих данных; есть индикаторы загрузки;
per-session метрики переживают reload.

**Architecture:** `SessionRuntime` в пуле (runner + usage + plan + busy + канал);
`snapshot(sessionId)` как единственный источник для REST/SSE; подписки клиента
вместо broadcast+фильтра; единый клиентский `applyState`.

**Tech Stack:** vanilla ESM (web assets), TypeScript strict, vitest (`bun test`),
happy-dom (dev-dep, для DOM-тестов), i18n en/ru.

**Спека:** [docs/specs/2026-10-02-web-session-state-design.md](../specs/2026-10-02-web-session-state-design.md)
**Зависимость:** [Session-Scope Isolation Plan](./2026-10-02-session-scope-isolation.md) — выполнен (слит в `master`).
**Ветка:** `feat/web-session-state` (Phase 1/2/4/5 слиты), `feat/webui-subscriptions` (Phase 0/3/7).

> **Статус (2026-10-02):** сделано —
> Phase 1 (`snapshot(sessionId)` + `GET /api/state?session=`),
> Phase 2 (клиентский `refresh` под `?session=<activeTab>` с guard'ом,
> `openTab`/`newChatTab` через `hooks.refreshState`, синхронные
> `activeSessionId`/`sidebarSessionChanged`),
> Phase 4 (loading-состояние секции Session: `.sb-loading` + `aria-busy`),
> Phase 5 (персист per-session usage + ленивая гидратация),
> Phase 3 (SSE-доставка: сначала per-session подписки `GET /events?session=`,
> затем **откат** — событие доставляется всем клиентам, раскладка по вкладкам
> на клиенте `feedForEvent`; один общий EventSource, фоновая вкладка стримится
> живьём. Причина отката: подписка только на активную сессию глушила фоновые
> вкладки — «второй поток» выглядел неработающим),
> Phase 0 (happy-dom-харнесс, `tests/webui-sidebar-dom.test.ts`),
> Phase 7 (e2e-сценарий переключения вкладок в `web-chat-tabs.e2e-test.ts`),
> Phase 6 (снятие legacy single-agent пути: `turns.ts` больше не ветвится по
> `hasFactory()`, web-ход всегда через раннер; `drainQueueTurn`/`submitLegacy`/
> `peekEarliest` удалены, `WebHost.submit` в web не поддерживается; тесты
> `webui-server`/`webui-auth` переведены на стаб-фабрику раннеров).
> Проверка: `bun test` 3010 pass / 6 skip / 0 fail, `bun run quality` зелёный.

---

## Phase 0: DOM-харнесс и клиентские тесты (задел)

### Task 0.1: happy-dom + тестовый DOM

**Files:**
- Modify: `package.json` (devDep `happy-dom`)
- Create: `tests/helpers/dom.ts`
- Modify: `tests/*` (новый `tests/webui-client.test.ts`)

- [x] **Step 1:** Добавить `happy-dom` в devDependencies; хелпер
  `mountDom()` поднимает минимальный DOM с `index.html`-разметкой сайдбара.
- [x] **Step 2:** Первые тесты (red по новому контракту): `applyState(snapshot)`
  рисует все секции; `openTab` сбрасывает Trace; guard по `sessionId`.
- [x] **Step 3: Run:** `bun test tests/webui-client.test.ts` Expected: FAIL
  (функции ещё нет — это контракт).
- [x] **Step 4: Commit**

```bash
git add package.json package-lock.json tests/helpers/dom.ts tests/webui-client.test.ts
git commit -m "test(webui): DOM harness and red client tests"
```

---

## Phase 1: Сервер — snapshot(sessionId)

### Task 1.1: `snapshot(sessionId)` из SessionRuntime

**Files:**
- Modify: `src/modules/webui/host-state.ts`
- Modify: `src/modules/webui/session-pool.ts`
- Test: `tests/webui-usage.test.ts`, `tests/webui-server.test.ts`

- [x] **Step 1:** `SessionRuntime` (или расширение слота пула) хранит
  `runner/usage/plan/busy`. `buildHostState` принимает `sessionId` первым
  аргументом и читает рантайм, не `getActive()`.
- [x] **Step 2:** Заглушить `getActive()` как fallback (legacy).
- [x] **Step 3: Run:** `bun test tests/webui-usage.test.ts tests/webui-server.test.ts` Expected: PASS.
- [x] **Step 4: Commit**

```bash
git add src/modules/webui/host-state.ts src/modules/webui/session-pool.ts
git commit -m "feat(webui): snapshot(sessionId) from session runtime"
```

### Task 1.2: `/api/state?session=`

**Files:**
- Modify: `src/modules/webui/server.ts`
- Test: `tests/webui-server.test.ts`

- [x] **Step 1:** Парсить `?session=`; без параметра — прежнее поведение
  (обратная совместимость). Отдавать `snapshot(session)`.
- [x] **Step 2: Run:** `bun test tests/webui-server.test.ts` Expected: PASS.
- [x] **Step 3: Commit**

```bash
git add src/modules/webui/server.ts
git commit -m "feat(webui): GET /api/state?session="
```

---

## Phase 2: Клиент — единый applyState и полный refresh

### Task 2.1: `applyState(snapshot)` + `openTab` полный апдейт

**Files:**
- Modify: `src/modules/webui/assets/app.js`
- Modify: `src/modules/webui/assets/js/tabs.js`
- Test: `tests/webui-client.test.ts`

- [x] **Step 1:** Вынести тело `renderState` в `applyState(snapshot, extra)`;
  полл, `openTab` и SSE `state` используют её.
- [x] **Step 2:** `openTab`: сразу `S.state.activeSessionId = id`, вызвать
  `sidebarSessionChanged(id)` синхронно, при получении `/api/state` — guard
  `if (snapshot.sessionId !== S.activeTabId) return`.
- [x] **Step 3:** `renderUsage`/`renderEnvironment`/`renderWorkspace`/
  `renderSessionsDropdown` вызываются при переключении.
- [x] **Step 4: Run:** `bun test tests/webui-client.test.ts tests/webui-assets.test.ts` Expected: PASS.
- [x] **Step 5: Commit**

```bash
git add src/modules/webui/assets/app.js src/modules/webui/assets/js/tabs.js
git commit -m "fix(webui): single applyState and full sidebar refresh on tab switch"
```

### Task 2.2: Trace bind на переключении

**Files:**
- Modify: `src/modules/webui/assets/js/sidebar.js`
- Test: `tests/webui-client.test.ts`

- [x] **Step 1:** `sidebarSessionChanged` вызывается из `openTab`;
  `sidebarPullLog` не дёргает старый `sid`.
- [x] **Step 2: Run:** `bun test tests/webui-client.test.ts` Expected: PASS.
- [x] **Step 3: Commit**

```bash
git add src/modules/webui/assets/js/sidebar.js
git commit -m "fix(webui): trace binds to the opened tab immediately"
```

---

## Phase 3: Подписки

> **Откат (2026-10-02):** per-session подписка оказалась вредной — браузер держит
> много вкладок-сессий, а подписка на одну глушила фоновые. Итог: сервер шлёт всё
> всем, клиент раскладывает по `sessionId`. `clientSessions`/`?session=` удалены.
> См. `fix/webui-multitab-sse`.

### Task 3.1: `GET /events?session=`

**Files:**
- Modify: `src/modules/webui/state.ts`, `src/modules/webui/server.ts`
- Test: `tests/webui-server.test.ts`

- [x] **Step 1:** Клиент объявляет сессию при connect/switch; сервер роутит
  события подписчикам сессии + глобальные. `broadcast` не зависит от
  `activeSessionId` для UI-состояния.
- [x] **Step 2:** Реконнект-ресинк сохраняется.
- [x] **Step 3: Run:** `bun test tests/webui-server.test.ts tests/webui-auth.test.ts` Expected: PASS.
- [x] **Step 4: Commit**

```bash
git add src/modules/webui/state.ts src/modules/webui/server.ts
git commit -m "feat(webui): per-session SSE subscriptions"
```

---

## Phase 4: Loading-индикаторы

### Task 4.1: Skeleton / aria-busy для Session/Plan/Usage

**Files:**
- Modify: `src/modules/webui/assets/index.html`, `assets/styles.css`
- Modify: `src/modules/webui/assets/js/feed.js`, `src/modules/webui/assets/js/app.js`
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/webui-client.test.ts`, `tests/i18n.test.ts`

- [x] **Step 1:** Флаг `sessionLoading` в `S.state`; set на activate/history,
  clear на `applyState`.
- [x] **Step 2:** Секции рендерят skeleton + `aria-busy`; ключи
  `web.sidebar.loading` (en/ru).
- [x] **Step 3: Run:** `bun test tests/webui-client.test.ts tests/i18n.test.ts` Expected: PASS.
- [x] **Step 4: Commit**

```bash
git add src/modules/webui/assets src/i18n/en.json src/i18n/ru.json
git commit -m "feat(webui): sidebar loading indicators"
```

---

## Phase 5: Персистентность метрик

### Task 5.1: Per-session usage на диск

**Files:**
- Modify: `src/modules/webui/run-agent.ts`, `src/modules/webui/state.ts`
- Modify: `src/modules/session/store.ts` (каталог/файл сессии)
- Test: `tests/webui-usage.test.ts`

- [x] **Step 1:** Писать/читать per-session summary (usage/заголовки ходов) в
  каталог сессии; `snapshot` подхватывает при переключении.
- [x] **Step 2: Run:** `bun test tests/webui-usage.test.ts tests/session-store.test.ts` Expected: PASS.
- [x] **Step 3: Commit**

```bash
git add src/modules/webui/run-agent.ts src/modules/webui/state.ts src/modules/session/store.ts
git commit -m "feat(webui): persist per-session usage summary"
```

---

## Phase 6: Снятие legacy-пути

### Task 6.1: Web всегда через SessionRuntime

**Files:**
- Modify: `src/modules/webui/{turns,session-pool,module,state,run-agent}.ts`
- Test: полный webui-набор

- [x] **Step 1:** Удалить ветки `hasFactory()`; главный агент — только для
  CLI/REPL.
- [x] **Step 2: Run:** `bun test tests/webui-*.test.ts` Expected: PASS.
- [x] **Step 3: Commit**

```bash
git add src/modules/webui
git commit -m "refactor(webui): remove legacy single-agent path"
```

---

## Phase 7: Финал

### Task 7.1: e2e-сценарий переключения вкладок + docs

**Files:** `tests/e2e/web-tab-switch.e2e-test.ts`, `AGENTS.md`, `CHANGELOG.md`

- [x] **Step 1:** e2e: открыть две сессии, переключить — сайдбар показывает
  данные активной, Trace пуст/свой, индикатор загрузки виден.
- [x] **Step 2: Run:** `bun run test:e2e` (по явной команде).
- [x] **Step 3:** AGENTS.md + CHANGELOG.
- [x] **Step 4: Полный прогон:** `bun run quality` + `bun test`.
- [x] **Step 5: Commit**

```bash
git add tests/e2e AGENTS.md CHANGELOG.md
git commit -m "test(webui): tab-switch e2e + docs"
```

---

## Приёмка

- [x] Acceptance criteria спеки B выполнены.
- [x] DOM-тесты покрывают applyState/openTab/Trace/loading.
- [x] e2e переключения вкладок зелёный.
- [x] `bun run quality` зелёный.
