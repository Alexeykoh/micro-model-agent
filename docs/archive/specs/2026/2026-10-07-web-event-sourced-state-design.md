# Web Event-Sourced State — Design Spec

**Status:** Draft (2026-10-07)
**Ветка:** `refactor/web-event-sourced-state`
**Связано:** [Web Session State Design](./2026-10-02-web-session-state-design.md) (частично реализована: per-tab проекция, `?session=`, guard)

---

## 1. Контекст

`mma web` обновляет сайдбар двумя независимыми контурами:

- SSE-событие `state` несёт **только счётчики** (`sessionStatus`), после чего клиент
  дёргает `GET /api/state`, чтобы получить полный снапшот (`app.ts:255`);
- плюс страхующий таймер `setInterval(refresh, 2000)` (`app.ts:405`) и
  `setInterval(loadSessions, 15000)` (`app.ts:408`).

Двойной источник истины — главный рудимент: снапшот строится по REST, события лишь
намекают «перечитай». Переключение вкладки зависит от сетевого раундтрипа, фоновая
вкладка не обновляется до полла.

## 2. Цели / Non-goals

**Цели:**
1. Единственный источник правды: снапшот сессии едет внутри SSE-события `state`.
2. Клиент хранит снапшот на вкладке; переключение — без сетевого запроса.
3. Отсутствие клиентских таймеров-поллов (`refresh 2s`, `loadSessions 15s`).
4. Список сессий обновляется событием `sessions`, а не поллом.
5. Код простой и короткий: один серверный хелпер, одна клиентская функция применения.

**Non-goals:**
- Смена внешнего вида (STYLE.md — канон).
- Терминальный REPL.
- Изменение `usage`-события (800мс live-метрики во время хода) — это не полл.
- Настоящая мульти-пользовательская синхронизация вкладок.

## 3. Целевой дизайн

### 3.1 Серверный хелпер `pushState`

Рядом с `sessionStatus` (`src/modules/webui/session/session-status.ts`):

```ts
export function pushState(s: RuntimeState & SseTransport, sessionId?: string | null): void {
  broadcast(
    {
      type: "state",
      ts: Date.now(),
      ...sessionStatus(s),
      ...(sessionId ? { sessionId } : {}),
      state: s.bridge?.getState?.(sessionId ?? undefined) ?? null,
    },
    s,
  );
}
```

`buildHostState` уже собрана и висит на `Host.getState(sessionId)` (`module.ts:257`);
хелпер — тонкая обёртка над существующим транспортом.

**Форма события `state`:**
`{ type, ts, sessionId?, state: HostStateSnapshot | null, busy, queueLen, runningSessionId, runningSessionIds, queued }`.

Поля `usage`/`usageSessionId` из события убираются: после `recordTurnUsage`
(`run-agent.ts:153`) usage уже лежит в `state.sessionUsage[owner]`, и снапшот
поднимает его через `activeUsage` (`state.ts:371`).

### 3.2 Точки эмиссии

Все текущие `broadcast({ type: "state", ...sessionStatus(s) })` заменяются на
`pushState(s, owner)`:

- `session/turns.ts` — 6 мест (spawn error, turn start, error, `finishTurn` ×3)
  с конкретным `sessionId` слота.
- `session/run-agent.ts:160` — после `recordTurnUsage` (sessionId = owner).
- `module.ts:172` — после re-index (глобально, без `sessionId`).

`state`-событие приветствия SSE (`server.ts:67`) остаётся counts-only: это один
клиент, а не broadcast; клиент резолвит снапшот сам.

### 3.3 Событие `sessions`

Новое SSE-событие `{ type: "sessions", ts, sessions: SessionMetaLite[] }`, где
`SessionMetaLite` — та же проекция, что отдаёт `GET /api/sessions`
(`sessions-api.ts:18-24`). Эмитится в `sessions-api.ts` после create/activate/delete.
15-секундный полл `loadSessions` удаляется; `loadSessions()` остаётся для
boot и reconnect.

### 3.4 Клиентская модель (`assets/`)

- **`tab.state: Dict | null`** — снапшот вкладки, в модели таба (`session/tabs.ts`,
  создание в `openTab`, `closeTab` не трогает).
- **`applyState(d)`** (`app.ts`):
  - если `d.sessionId` и вкладка открыта — `tab.state = d.state`;
  - всегда: `session.runningSessionId(s)`/`queued`/`busy` из счётчиков +
    `reconcileTabStatuses()`;
  - если `d.sessionId === tabState.activeTabId` (или событие без `sessionId`) —
    `renderActiveState()`.
- **`renderActiveState()`**: `session.host = activeTab()?.state || {}`, затем
  существующий рендер (`plan/usage/env/map/lsp/workspace/dropdown`). `session.host`
  остаётся «зеркалом активной вкладки для рендера» — минимум правок в рендерах.
- **`ensureTabState(id)`**: `tab.state` есть → рендер сразу; иначе один
  `GET /api/state?session=id` → `tab.state` → рендер, если всё ещё активна.
  Используется в `openTab` и при reconnect (по каждой открытой session-вкладке).
- **SSE `state`** → `applyState(d)` (вместо `void refresh()`).
- **SSE `sessions`** → `session.sessions = d.sessions; renderSessionsDropdown()`.
- **SSE `usage`** → мерж в `tab.state` владельца; если владелец активен —
  `session.host = {...session.host, ...d.usage}; renderUsage(session.host)`.
- **Удаляются**: `setInterval(refresh, 2000)` и `setInterval(loadSessions, 15000)`.

## 4. Поток данных

```
изменение (ход/план/usage/конфиг/activate)
   → pushState(s, sessionId)
   → broadcast(ev) → все SSE-клиенты
   → applyState(ev): tab.state[ev.sessionId] = ev.state
   → если это активная вкладка → renderActiveState() (session.host = tab.state)

переключение вкладки
   → openTab(): ensureTabState(id) — из памяти (мгновенно) или 1 REST
   → renderActiveState()

reconnect
   → ensureTabState(id) по всем session-вкладкам + loadSessions()
```

## 5. Acceptance criteria

1. Два открытых таба, ход в фоновом: его `tab.state` обновляется; переключение
   показывает свежие данные без REST-запроса.
2. `setInterval`-поллов на клиенте (refresh 2s, loadSessions 15s) нет.
3. Create/rename(через `state.sessionName`)/delete/activate обновляют список
   сессий событием `sessions`.
4. Быстрое A→B→A не оставляет данных B в A (guard по `sessionId` в `applyState`).
5. Reconnect восстанавливает все открытые вкладки (`ensureTabState`), не только
   активную.
6. `usage`-событие во время хода по-прежнему наполняет сайдбар.
7. `bun test` + `tsc --noEmit` + `bun run quality` зелёные.

## 6. Тестовая стратегия

- **Сервер:** `pushState` кладёт `state`+`sessionId` в событие; `sessions`-событие
  на create/delete/activate; на `turn_end` нет двойного `state` (usage уже внутри).
- **Клиент (happy-dom, харнесс существует):** `applyState` пишет в `tab.state`;
  guard по `sessionId`; `ensureTabState` берёт из памяти без `fetch`; переключение
  не дёргает сеть.
- **Guard:** в `assets/js/**` не осталось `setInterval(...refresh...)` /
  `setInterval(...loadSessions...)`.
- **e2e (`bun run test:e2e`, по явной команде):** событие `state` несёт `state`;
  переключение вкладок — приёмочный сценарий `web-chat-tabs`.

## 7. Миграция и совместимость

- `GET /api/state?session=<id>` сохраняет форму `{...sessionStatus, state}`
  (обратная совместимость; используется для boot/reconnect/ensure).
- `Host.getState` / `buildHostState` не меняются.
- Legacy `state`-событие без `state`-поля (старый клиент) деградирует до прежнего
  поведения — но полигон только наш фронтенд, шипа на время перехода не делаем.

## 8. Риски

- Рост размера `state`-события (снапшот, включая `projectMap`/`instructions`):
  события дискретны (не на каждый токен), объём — единицы КБ; backpressure-дроп
  в `broadcast` уже есть.
- Забыть `pushState` в точке изменения → застой снапшота до следующего события;
  закрывается тестами точек эмиссии.
- Гонка activate/switch: guard по `sessionId` в `applyState` + `ensureTabState`
  с проверкой активной вкладки.

## 9. Порядок

1. Серверный хелпер `pushState` + замена точек эмиссии (`turns`, `run-agent`,
   `module`) + `sessions`-событие.
2. Клиент: `tab.state`, `applyState`, `renderActiveState`, `ensureTabState`,
   обработчики `state`/`sessions`/`usage`, удаление таймеров.
3. Тесты (сервер/клиент/guard), e2e-ожидания, `AGENTS.md` + `CHANGELOG.md`.
