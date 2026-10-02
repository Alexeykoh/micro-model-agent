# Web Session State & Per-Tab Projection — Design Spec

**Status:** Draft (2026-10-02)
**Ветка:** `docs/web-session-state`
**Связано:** [Session-Scope Isolation Design](./2026-10-02-session-scope-isolation-design.md),
[Web Session State Plan](../plans/2026-10-02-web-session-state.md)

---

## 1. Контекст

В `mma web` есть вкладки сессий (`tabs.js`) и сайдбар (Session / Map / Trace,
`sidebar.js`). После фичи параллельных раннеров (`2e886e0`) и двух follow-up
фиксов (`3838501`, `e980ce7`) пользователь видит:

- медленное обновление сайдбара;
- данные не соответствуют открытой вкладке;
- нет индикаторов загрузки;
- при переключении данные не всегда обновляются/отображаются.

Эти симптомы — не баги рендера, а **структурный дефект**: у UI и сервера два
независимых представления «активной сессии», сходящихся только через
`POST /api/sessions/activate` и 2-секундный полл.

## 2. Проблема (по коду)

### 2.1 Сайдбар строится от серверной активной сессии

- `src/modules/webui/host-state.ts:76` — `sessionManager.getActiveMeta()`
- `src/modules/webui/state.ts:285-295` — `activeUsage` по `getActive()`
- `src/modules/webui/module.ts:113-127` — `activeExecModule` по `getActive()`
- `src/modules/webui/server.ts:98-103` — `/api/state` отдаёт это состояние

Клиент имеет свой `S.activeTabId`, который выставляется мгновенно в `openTab`
(`tabs.js:213`), а серверный active меняется только после ответа activate.
`GET /api/state` не несёт «какую сессию смотрит вкладка».

### 2.2 Полная перерисовка только по 2с-поллу

- `src/modules/webui/assets/app.js:343` — `setInterval(refresh, 2000)`
- SSE `state` вызывает `refresh()` (`app.js:210`)
- «Быстрый» путь `openTab` частичный: только `renderPlan`/rail/busy
  (`tabs.js:248-260`); `renderUsage`/`renderEnvironment`/`renderWorkspace`/
  `sidebarSessionChanged`/`renderSessionsDropdown` — нет.

### 2.3 Рассинхрон `activeSessionId`

`S.state.activeSessionId` присваивается только в `renderState`
(`app.js:75`), поэтому после клика отстаёт на цикл полла. От него зависят:

- подсветка активной сессии в дропдауне (`tabs.js:391,400`);
- гейт мержа usage (`app.js:214-218`) — свежий ход может быть отброшен.

`openTab` не выставляет `S.state.activeSessionId` и не проверяет, что ответ
`/api/state` ещё соответствует `S.activeTabId` (`tabs.js:248-256`) — поздний
ответ прошлой сессии перетирает текущую.

### 2.4 Trace привязан к серверной сессии

`sidebarSessionChanged` (сброс Trace, `sbEl.dataset.sid`) вызывается только из
`renderState` (`app.js:94`, `sidebar.js:238-252`). `sidebarPullLog` читает
`sbEl.dataset.sid` (`sidebar.js:357-359`) → до полла докачивает чужой лог.

### 2.5 Нет индикаторов загрузки

У Session / Plan / Usage нет скелетона или `aria-busy`
(`index.html:118-131`). Индикаторы есть только у Map (`sidebar.js:574-621`) и
Trace (`sidebar.js:626-637`). Плейсхолдер `web.history.loading` — только в
ленте (`feed.js:842`).

### 2.6 `sessionUsage` не персистится

`state.ts:174`, `run-agent.ts:57-67` — карта в памяти; после reload/restart
сайдбар теряет цифры.

## 3. Цели / Non-goals

**Цели:**
1. Единственный источник правды для сайдбара — активная вкладка клиента.
2. Мгновенный, полный апдейт сайдбара при переключении (без ожидания полла).
3. Отсутствие гонок: поздний ответ прошлой сессии не перетирает текущую.
4. Trace всегда принадлежит открытой вкладке.
5. Индикаторы загрузки для Session/Plan/Usage.
6. Персистентность per-session метрик (reload/restart).

**Non-goals:**
- Смена внешнего вида (STYLE.md — канон).
- Терминальный REPL.
- Настоящая синхронизация между вкладками одного пользователя (не цель).

## 4. Целевой дизайн

### 4.1 `SessionRuntime` в пуле

Пул становится реестром `Map<sessionId, SessionRuntime>`. Рантайм владеет:
runner, `usage`, `plan`, `busy/queue`, канал событий. Главный агент остаётся
для CLI/REPL; web **всегда** идёт через рантайм — ветки `hasFactory` исчезают.

### 4.2 Явный session-scoped snapshot

- `snapshot(sessionId): HostStateSnapshot` — одна чистая функция для REST и SSE.
- `GET /api/state?session=<id>` (или `/api/sessions/:id/state`).
- `buildHostState` принимает сессию параметром, а не читает `getActive()`.

### 4.3 Подписки вместо broadcast с клиентской фильтрацией

- Клиент при connect/switch объявляет активную сессию
  (`GET /events?session=<id>` или `POST` о подписке).
- Сервер роутит события подписчикам сессии (+ глобальные), `broadcast` перестаёт
  опираться на `activeSessionId`-штамп для UI-состояния.

### 4.4 Единый клиентский апдейт

- Один `applyState(snapshot)` (`app.js`), используемый и поллом, и `openTab`, и
  SSE `state`.
- `openTab` вызывает `applyState` (полный), сразу ставит `S.state.activeSessionId`,
  синхронно сбрасывает Trace (`sidebarSessionChanged`).
- Guard: применить ответ только если `snapshot.sessionId === S.activeTabId`.

### 4.5 Loading-состояния

- `S.state.sessionLoading` (или per-tab) на время activate/history.
- Секции Session/Plan/Usage рендерят skeleton/`aria-busy` по этому флагу.

### 4.6 Персистентность

- Per-session summary (usage/заголовки ходов) — либо из `session.jsonl`/meta
  на диск, либо маленький `usage.json` в каталоге сессии; `snapshot` подхватывает
  при переключении.

## 5. Acceptance criteria

1. Переключение вкладки A→B→A: сайдбар показывает B сразу (без 2с-полла), затем
   A — мгновенно; `S.state.activeSessionId` корректен синхронно.
2. Trace очищается в момент переключения и не содержит строк чужой сессии.
3. `renderUsage`/`renderEnvironment`/`renderSessionsDropdown` обновляются на
   переключении (не только по поллу).
4. Быстрое A→B→A не оставляет данных B в A (guard по `sessionId`).
5. Skeleton/`aria-busy` виден на время загрузки.
6. После reload usage/plan вкладки консистентны (persist).
7. `bun test` + `tsc --noEmit` зелёные.

## 6. Тестовая стратегия (обязательный задел)

Сейчас клиент проверяется только совпадением строк и e2e
(`tests/webui-assets.test.ts:19-20`). До рефакторинга:

- Добавить DOM-харнесс (`happy-dom`) и component-тесты на `applyState`,
  `openTab`, `sidebarSessionChanged` (сброс/данные), guard по `sessionId`.
- Серверные тесты: `snapshot(sessionId)` вместо `getActive()`, подписки.
- e2e (`bun run test:e2e`, только по явной команде) — сценарий переключения
  вкладок как приёмочный.

## 7. Миграция и совместимость

- Legacy-путь (`hasFactory=false`) сохраняется до паритета; вводится флаг/шип,
  затем удаляется.
- `GET /api/state` без `session` возвращает прежнее поведение (обратная
  совместимость на переходный период).
- Плагинный `hostBridge` и команды переводятся на `SessionRuntime` (зависит от
  спеки A).

## 8. Риски

- Снятие legacy затрагивает тесты, завязанные на фабрику/не-фабрику.
- Подписки меняют контракт `/events` — нужен реконнект-ресинк.
- Без DOM-харнесса рефактор клиента слепой — потому тестовая сеть идёт первой.

## 9. Порядок

Спека B зависит от A (изоляция логов/провайдера/вывода — иначе `snapshot` и
Trace будут нести чужую сессию). Исполнение — план
[`2026-10-02-web-session-state.md`](../plans/2026-10-02-web-session-state.md)
после завершения плана A.
