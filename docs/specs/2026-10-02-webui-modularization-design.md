# WebUI Modularization — Design Spec

**Status:** Draft (2026-10-02)
**Ветка:** `refactor/webui-modularize`
**План:** [2026-10-02-webui-modularization.md](../plans/2026-10-02-webui-modularization.md)
**Связано:** [WebUI Decompose (базовый, 2026-09-26)](../plans/2026-09-26-webui-decompose.md),
[Web Session State](./2026-10-02-web-session-state-design.md),
[Session-Scope Isolation](./2026-10-02-session-scope-isolation-design.md)

---

## 1. Контекст

WebUI уже проходил декомпозицию (2026-09-26): бэкенд разбит на плоские `.ts`, фронт —
на ES-модули (`assets/js/*.js`), роуты сведены в таблицу (`server.ts`), дедуп вынесен
(`body.ts`, `persist.ts`). После этого `master` вобрал серию крупных изменений:

- per-session раннеры и настоящий параллелизм (`RunPool`, `session-pool.ts`);
- per-session SSE-подписки и scoped broadcast (`706350d`, `c657b2b`);
- session-scoped `/api/state` и usage (`0daef56`, `41f8a2f`);
- удаление legacy-пути одиночного агента (`e8ca5ec`, `833a402`) — web всегда идёт
  через per-session раннер;
- LSP-доктор и вкладка LSP в сайдбаре (`2e190b9`, `d4b5db6`).

Итог: модуль стал **центрее** (в нём теперь и рантайм сессий, и транспорт, и UI-слой),
при этом точки входа по-прежнему размазаны, а состояние — два общих мутабельных объекта.
Это нормальный момент для второго прохода: он ещё дешёвый, пока per-session-структуры
свежие и покрыты тестами.

### Предпосылки, подтверждённые кодом

- **Runtime-циклов нет.** И бэкенд (`*.ts`), и фронт (`assets/js/*.js`) — ацикличные DAG
  по value-импортам. На бэкенде есть только *type-only* обратные рёбра (например,
  `session-pool.ts`/`session-usage.ts` → `import type … from "./state"` при value-импорте
  обратно) — это нормальный TS-паттерн, erasure на рантайме; guard-тест их игнорирует.
  Единственная инверсия слоёв во фронте: `settings.js → tabs.js`.
- **Реальная связность — не в размере файлов, а в двух объектах:**
  - backend: `WebUiState` (`src/modules/webui/state.ts`) — **35** из 38 файлов модуля
    импортируют `./state` и принимают полный тип;
  - frontend: `S` (`assets/js/store.js`) — единый singleton, `S.state` читается/пишется
    ~169 раз из всех модулей.
- Файловый обмен с webui извне `src/` — две точки (`web-command.ts`), поэтому внутренние
  пути можно двигать свободно. Тестовые импорты глубже (80 строк в 32+ файлах) — их
  движение требует либо обновления импортов, либо compatibility-barrel'ов.

## 2. Проблема (по коду)

### 2.1 Backend — плоская папка без доменов

`src/modules/webui/` — 38 `.ts` в одной директории. Домены (транспорт, сессии, настройки,
чат, файлы, i18n) не видны из раскладки: `actions-api.ts` и `log-forward.ts`, `setup-api.ts`
и `reconfigure.ts` лежат рядом. Навигационный налог (цель **A**).

### 2.2 Backend — `WebUiState` как god-object / service locator

`state.ts:126-254` — один интерфейс на ~60 полей, покрывающий транспорт, рантайм агента,
конфиг, сессии, окружение, память, скиллы, плагины, настройки. Практически каждый модуль
принимает `state: WebUiState` и дёргает из него произвольный срез:

- `forward.ts`, `log-forward.ts` — только `clients`/`activeSessionId` (broadcast);
- `config-api.ts`, `providers-api.ts` — `config`/`saveConfig`/`reconfigure`/`knownModels`;
- `sessions-api.ts` — `sessionManager`/`execModule`/`sessionUsage`;
- `file-api.ts`, `log-api.ts` — `sessionManager` + узкие поля.

Из-за широкого типа компилятор не подсказывает, что модулю на самом деле нужно, и любое
поле `WebUiState` доступно отовсюду. Именно это (цель **B**), а не число строк.

### 2.3 Frontend — legacy-точки входа в корне + большой `S`

- В `assets/` вперемешку: точки входа `app.js` (380), `setup.js` (816, classic IIFE),
  `md.js` (272) — и модули в `assets/js/` (18 файлов). Раскладка неоднородна (A).
- `store.js` — единый `S`: конфиг, модели, сессии, host, tab-модель, стрим-состояние фида,
  run-складки, дедуп-подписи и формы настроек в одном объекте. Модули, которые логически
  владеют только своей частью (`feed.js` владеет `run*`/`curMd`, `tabs.js` — `attachments`,
  `settings.js` — формами), читают и пишут общий `S` (B). Модули не могут объявить, какой
  срез `S` им реально нужен: связь держится на соглашении, а не на контракте.

### 2.4 Frontend — инверсия `settings → tabs`

`settings.js:12` импортирует из `tabs.js` два menu-хелпера (`closeAllMenus`, `setSessOpen`),
хотя слой `settings` выше `tabs`. Сегодня это не цикл, потому что `tabs.js` не импортирует
`settings.js`; но это хрупко: первый же обратный импорт замкнёт граф. Задокументировано в
`store.js:84-87`.

### 2.5 Сознательно крупные файлы

| Файл | Строк | Примечание |
|---|---:|---|
| `assets/js/settings.js` | 1914 | панели + провайдер + поиск + модалка + sub-dialog |
| `assets/styles.css` | 1627 | секции, размечены комментариями |
| `assets/js/feed.js` | 1260 | фид + стрим + turn + история + plan/question + usage/env сайдбара |
| `assets/js/tabs.js` | 1051 | табы + сессии + композер + автокомплит + send |
| `assets/js/sidebar.js` | 859 | Session/Map/Trace/LSP |
| `assets/setup.js` | 816 | отдельный визард (вне основного приложения) |
| `src/modules/webui/settings-api.ts` | 693 | принятое исключение (плоская таблица роутов) |
| `assets/js/settings-controls.js` | 452 | generic-контролы + structured-редакторы |

Часть крупных файлов была оставлена целой осознанно (панели `settings` ↔ циклы;
`settings-api.ts` — исключение в AGENTS.md). Цель **C** — уменьшить размеры там, где
есть чистый шов, не ломая связность.

## 3. Цели и не-цели

### Цели

1. **A — навигация.** Раскладка по доменам/фичам: по имени файла видно, куда он относится.
   Единообразие точек входа.
2. **B — change-safety.** Модуль зависит от **узкого** контракта, а не от god-object:
   backend — role-интерфейсы состояния; frontend — per-domain сторы. Плюс guard-тесты
   на границы/циклы.
3. **C — размер.** Разрезать крупные файлы по чистым швам; сохранить принятые исключения.

### Не-цели

- Никакого UI-фреймворка, бандлера или отдельного npm-пакета/workspace.
- Никакой новой функциональности и смены поведения (рефакторинг behaviour-preserving).
- Не трогаем MoE-путь, терминальный REPL/UI, ядро агента.
- Не переписываем `styles.css` «с нуля» — только секционное дробление, если понадобится.

## 4. Инварианты

Внешние контракты webui по решению владельца **не заморожены**, но любую их смену
считаем отдельным осознанным решением, а не побочным эффектом рефакторинга. По умолчанию
сохраняем:

- имена/формат SSE-событий + `sessionId`-штамп (`state.ts:broadcast`);
- REST-роуты, коды и тела (`API_ROUTES` в `server.ts`);
- формат `session.jsonl` и `SessionMeta`/`SessionMessage`;
- ключи конфига и MCP/LSP-структуры;
- plugin API (`HostBridge`/`subscribeOutput`) — если не потребуется смена, не трогаем.

Обязательные инварианты процесса: `bun test` (база ~2900 pass / 0 fail), `tsc --noEmit`,
`bun run quality` — зелёные на каждой фазе; per-session поведение (параллелизм, изоляция,
SSE по вкладкам) не регрессирует.

## 5. Целевая архитектура

### 5.1 Backend — доменные подпапки

```
src/modules/webui/
  module.ts            # composition root (остаётся на месте — внешняя точка входа)
  server.ts            # HTTP-транспорт: handleRequest, SSE, статика, API_ROUTES
  assets.ts            # загрузка ассетов (src + dist)
  limits.ts            # капы (body/clients)
  util.ts              # shared transport helpers (auth, json, resp)
  http/
    body.ts            # parseJsonBody/readJsonBody
    persist.ts         # persistAndReconfigure
  state/
    types.ts           # UsageSnapshot, QueuedMessage, WebUiAssets, SseEvent, web-адаптеры
    transport.ts       # SseTransport + broadcast (роль: клиенты/штамп сессии)
    runtime.ts         # RunPool, busy/agentRunning, bridge, turnSeq, pendingQuestions
    sessions.ts        # WebSessionManager, sessionUsage, activeSessionId, activeUsage
    config.ts          # config/saveConfig/reconfigure/knownModels
    workspace.ts       # workspace, agentsMd, projectMap, lsp, memory, skills, plugins
    index.ts           # composition: WebUiState, createWebUiState
  session/
    sessions-api.ts, history-api.ts, log-api.ts,
    session-pool.ts, session-status.ts,
    run-agent.ts, turns.ts, forward.ts, prompt-io.ts, answer-api.ts
  settings/
    settings-api.ts, config-api.ts, providers-api.ts, providers-view.ts,
    model-cache.ts, reconfigure.ts, setup-api.ts, reasoning-view.ts,
    commands-settings.ts
  chat/
    actions-api.ts, commands.ts, commands-shared.ts, memory-commands.ts
  file/file-api.ts
  lsp/lsp-api.ts
  i18n/i18n-api.ts, i18n-stale.ts
  assets/              # статика (без изменений раскладки на этой фазе)
```

**Compatibility-barrel:** `state.ts` в корне сохраняем как реэкспорт из `state/index.ts`
(`export * from "./state/index"`). Это оставляет рабочими 32 тест-файла и внешние импорты
`webui/state` без массовой правки. После фазы 2 (узкие интерфейсы) barrel может быть
удалён, а тесты переведены на `./state` — решается в плане.

### 5.2 Backend — role-интерфейсы состояния

Вместо `state: WebUiState` каждый модуль принимает **структурный срез**, который реально
использует. Идиома в репозитории уже есть (`WebSessionManager`, narrow `Pick` для
`execModule`). Примеры:

| Модуль | Контракт |
|---|---|
| `forward.ts`, `log-forward.ts` | `SseTransport` |
| `config-api.ts` | `ConfigStore & SseTransport` |
| `sessions-api.ts` | `SessionStore & ConfigStore & SseTransport` |
| `file-api.ts` / `log-api.ts` | `SessionStore` (+ `SseTransport`) |
| `run-agent.ts` / `turns.ts` | `RuntimeState & SessionStore & SseTransport` |
| `settings-api.ts` | `WorkspaceStore & ConfigStore & SseTransport` |

`WebUiState` остаётся **композицией** ролей и используется оркестратором (`module.ts`)
и тестами, которые строят `createWebUiState()`. Роли — пересекаемые (`interface`/`Pick`)
и совместимы по структуре, так что единый рантайм-объект остаётся валиден.

### 5.3 Frontend — фичевые подпапки

```
assets/
  index.html
  styles.css           # (опц.) позже — styles/*.css по секциям
  app.js               # ESM-вход (опц. позже → js/app.js; см. §6, Phase 6)
  setup.js             # classic-вход визарда (вне основного графа)
  md.js                # markdown-мост (ESM, рядом с vendor)
  js/
    core/
      api.js, dom.js, i18n.js, format.js, dialog.js,
      menus.js         # НОВЫЙ: closeAllMenus/setSessOpen (leaf) — снимает инверсию
      store/
        index.js       # hooks + общий реэкспорт срезов
        feed.js        # стрим/turn/run-складки, дедуп-подписи
        tabs.js        # tabs/activeTab/liveTab/composer
        settings.js    # config/providers/панели/формы
        session.js     # sessions/host/busy/running/queued
    feed/
      core.js, stream.js, turn.js, history.js, plan.js, question.js, sidebar.js
    session/
      tabs.js, composer.js, sessions-menu.js, cmdk.js
      sidebar/ core.js, trace.js, map.js, lsp.js
    settings/
      modal.js, search.js, providers.js, panels.js, subdialog.js,
      controls.js, editors.js
```

`menus.js` — единственный новый модуль на первом шаге; он же закрывает `settings → tabs`.
Порядок извлечения подобран так, чтобы не появлялось циклов (см. analysis в плане).

### 5.4 Frontend — срезы стора

`S` распадается на per-domain объекты (`feedStore`, `tabStore`, `settingsStore`,
`sessionStore`), которые импортируются только своими доменами. Общий `hooks` (сейчас
`applyStaticI18n`) остаётся в `core/store/index.js` как sanctioned-канал инверсии.
Скалярные поля не удаляются, а переезжают в свои срезы; доступы `S.state.*` (169)
заменяются на `sessionStore` / `settingsStore` по владельцу.

> Риск: это самая объёмная и «шумная» часть (frontend B). Она выделена в отдельную
> позднюю фазу и может быть отложена, не блокируя A/C.

### 5.5 Guard-тесты границ

- **Backend:** тест, который парсит импорты `src/modules/webui/**` и падает, если доменный
  модуль импортирует `state.ts`/`state/index` ради полного `WebUiState` (whitelist для
  `module.ts`/composition). По образцу `tests/output/no-direct-console.test.ts`.
- **Frontend:** тест-обход import-графа `assets/js/**` — запрет runtime-циклов и «обратных»
  рёбер (`settings/* → session/tabs`, `feed/* → settings/*` и т.п.).
- Оба — детерминированные, без сети/браузера; type-only рёбра не считаются runtime-циклами.

## 6. Стратегия миграции

Один крупный заход, но **инкрементальными фазами** с зелёными проверками после каждой.
Фазы 0–4 дают A + большинство C при минимальном риске; фазы 5–6 — B (глубокая
развязка). После любой фазы `master`-качество сохраняется, ветку можно остановить.

| Фаза | Что | Цель | Риск |
|---|---|---|---|
| 0 | Baseline + guard-тесты (boundary/cycles) | — | низкий |
| 1 | Backend: подпапки + compatibility-barrel | A | низкий |
| 2 | Backend: role-интерфейсы + перевод модулей | B | средний |
| 3 | Frontend: leaf-модули (`settings-editors`, `sidebar/*`, `feed/core`) | A, C | низкий |
| 4 | Frontend: `menus.js`, снятие инверсии | B | низкий |
| 5 | Frontend: разрезать `feed.js`/`tabs.js`/`settings.js` | A, C | средний |
| 6 | Frontend: срезы `S` (+ возможно перенос точек входа) | B | высокий |
| 7 | Docs/AGENTS/CHANGELOG, финальная сверка | — | низкий |

Правило: **никаких смешанных коммитов** — структурный перенос и изменение логики не
в одном шаге. Каждый шаг проверяется `bun test` + `tsc --noEmit`; фронт-шаги дополнительно
`node --check` + обход import-графа.

## 7. Верификация

1. `bun test` — 0 fail (база фиксируется на фазе 0).
2. `tsc --noEmit` — чисто.
3. `bun run quality` — без новых lint/dead-code находок (`.fallow-baseline.json`).
4. `bun run test:e2e` — зелёный (только по явной команде, Playwright).
5. Guard-тесты §5.5 — зелёные; число файлов `src/modules/webui/**` и `assets/js/**`,
   превышающих целевой размер, не растёт.
6. Ручной smoke `bun run web:dev` (по запросу) — чат, вкладки, настройки, сайдбар.

## 8. Риски и их снижение

| Риск | Снижение |
|---|---|
| Разрез `feed`/`tabs`/`settings` ломает хрупкие DOM-связи | e2e-харнесс + DOM-тесты уже есть; резать последними, по швам из анализа |
| Срезы `S` — 169 доступов, легко протащить регресс | отдельная фаза, инкрементально по домену, `S`-совместимые accessors на переходный период |
| Движение backend-файлов рвёт 80 тест-импортов | compatibility-barrel `state.ts`; остальные пути правятся точечно, тесты — тем же PR |
| Свежий per-session код (`session-pool`/`turns`/`forward`) регрессирует | эти файлы не переписываются — только переносятся/меняют тип аргумента |
| Shum в diff, тяжёлое ревью | фазы и «только перенос» отделены от «только логика/типы»; guard-тесты ловят циклы |
| `settings-api.ts` 693 — принятое исключение | остаётся как есть (AGENTS.md); при желании — отдельным решением |

## 9. Открытые решения (зафиксировать в плане)

1. Удалять ли compatibility-barrel `state.ts` после фазы 2 (и переводить тесты) или
   оставить как публичный фасад модуля.
2. Дробить ли `styles.css` (1627) на `styles/*` — сейчас размечен комментариями, выигрыш
   только в навигации.
3. Переносить ли точки входа `app.js`/`setup.js`/`md.js` в `js/` (churn в `index.html` +
   `assets.ts` + роуте) или оставить в корне как «entry» — решение по факту фазы 6.
4. Нужен ли frontend-типизированный стор (`// @ts-check` + JSDoc) как постоянный ratchet,
   или достаточно guard-теста границ.
