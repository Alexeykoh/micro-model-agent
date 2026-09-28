# Привязка плана к сессии (session ↔ plan binding)

Дата: 2026-09-29
Статус: в работе
Ветка: `fix/session-plan-binding`

## 1. Проблема

План исполнения глобален на проект (`<baseDir>/.mma/plans/active.json`, синглтон `ExecutionModule.tracker`), а сессии — независимы (`SessionManager.activeId`).

Следствия (подтверждены чтением кода, без изменений):

- смена сессии (`POST /api/sessions/activate`, `/resume`, `/new`) трекер плана не трогает;
- сайдбар `mma web` (`buildHostState` → `execModule.getActivePlan()`, полл `/api/state` 2с) показывает один и тот же план во всех чатах;
- новая сессия наследует чужой план; предыдущий план нигде не прячется;
- in-feed карточки плана per-tab (`tab.planCard`, роутинг `feedForEvent(sessionId)`), а сайдбар — глобальный: расщепление.

## 2. Цель

- Каждая сессия имеет **свой активный план** (или его отсутствие).
- Смена сессии переключает план в трекере и в сайдбаре; чужой план не виден.
- Новая сессия стартует без плана.
- Черновики/архив остаются общей библиотекой (как сейчас).

## 3. Non-goals

- Не переносим черновики/архив в per-session (общая библиотека сохраняется: `plan list/switch` между сессиями работает).
- Не трогаем MoE-планы (`moe_plan` — отдельный контур).
- Не меняем формат `Plan` (без `sessionId` внутри — привязка снаружи, в путях стора).
- Не меняем семантику сайдбара «показывает серверно-активную сессию» — переключение вкладки и так активирует сессию на сервере.

## 4. Дизайн

### 4.1 Стор: per-session слот активного плана

`PlanStore`:

- новый корень `plans/sessions/<sessionId>/active.json` (валидация: `sessionId` без `/..\`, иначе throw);
- методы:
  - `saveSessionActive(sessionId, plan)`,
  - `loadSessionActive(sessionId): Plan | null` — чистый слот, без fallback
    (иначе каждая новая сессия наследовала бы чужой план через глобальный `active.json`),
  - `clearSessionActive(sessionId)`;
- глобальные `saveActive/loadActive/clearActive`, `drafts/`, `archive/` — без изменений (back-compat + тесты).

### 4.2 Модуль: трекер следует за сессией

`ExecutionModule`:

- `private sessionId: string | null = null`;
- `switchSession(id: string | null)`:
  1. персистит текущий трекер в слот старой сессии (`saveSessionActive` при трекере, иначе `clearSessionActive` — чтобы пустота тоже запоминалась и не воскрешала старый план возвратом);
  2. `sessionId = id`;
  3. загружает план новой сессии (`loadSessionActive`) в трекер (+ `syncCurrentStep`, сброс `completedPlan`/`_auditSkipsRemaining` как в `setPlan`/`restorePlan`);
  4. завершённый на диске план — в архив (та же логика, что `restorePlan`);
- `setPlan()` дополнительно пишет в слот текущей сессии (если `sessionId` выставлен);
- `getActivePlan()` без изменений — теперь возвращает план **текущей** сессии;
- план-тулы (`create/switch/abort/update/re-plan`) работают через `setPlan/trackerRef/store` как раньше, но активный слот — сессионный: `switch`/`abort` чистят/ставят слот текущей сессии, `delete/purge` — глобальные как раньше.

### 4.3 Точки переключения (все должны звать `switchSession`)

| Точка | Сейчас | Станет |
|---|---|---|
| Bootstrap (`modules-phase`) | `restorePlan()` до известной сессии | после создания `sessionManager`: `execModule.switchSession(sessionManager.getActive())` (восстанавливает план стартовой сессии) |
| REPL `/resume` | `setActive` + `setContext` | + `agent.getModule("execution").switchSession(match.id)` |
| REPL `/new` | `create` + `clearContext` | + `switchSession(meta.id)` (пусто → трекер null) |
| Web `POST /api/sessions/activate` | `manager.setActive` | + `execModule.switchSession(id)` (новый коллаборатор `state.execModule`) |
| Web `POST /api/sessions` (create → уже active) | только `create` | + `switchSession(newId)` |
| Web `DELETE /api/sessions/:id` | удаление меты | + `clearSessionActive(id)` (не оставлять мусор; активную удалять и так нельзя — 409) |

`Agent.run` автосоздаёт сессию при отсутствии (`agent.ts`) — там `execModule` недоступен; закрывается bootstrap-синком + точками выше (первый ход идёт в стартовой/активной сессии, чей план уже загружен).

### 4.4 Миграция legacy `active.json`

- Bootstrap: `restorePlan()` поднимает глобальный план в трекер, затем
  `switchSession(activeId)` усыновляет его в слот стартовой сессии (persist
  трекера без `prev`). Глобальный файл остаётся как legacy-зеркало.
- Поведение: сессия, активная на момент обновления, подхватывает старый план;
  остальные стартуют пустыми. Честно и без размножения чужого плана по всем сессиям.
- Синхрон трекера в слот идёт из трёх мест (всё fail-open):
  1. `setPlan()` — создание/переплан;
  2. `trackerRef`-сеттер — план-тулы (`abort/switch/delete/purge`), пишущие мимо `setPlan`;
  3. `flushSessionPlan()` — внутренние `saveActive` (auto-close/auto-advance);
  4. `switchSession()` — persist уходящей стороны при каждом переходе.

### 4.5 Фронт (`mma web`)

- `openTab(..., server=true)` (`tabs.js`): после `POST /api/sessions/activate` дёрнуть `refresh()` (уже есть в `app.js`, экспортировать) — сайдбар сразу показывает план новой сессии, а не ждёт 2с-полла.
- `renderState`/`renderPlan`/`onPlan`/`feedForEvent` — без изменений (уже per-tab для ленты и глобальный-для-активной для сайдбара; после 4.2 «глобальный» == «текущей сессии»).
- Rail (`railPlan`) — без изменений, едет на том же снапшоте.

### 4.6 REPL-рендер

- `/resume` и `/new` после `switchSession` показывают строку состояния плана (тот же `formatPlanChecklist`-gist, что `planBlock`, одной строкой: `◇ <title> — done/total` или `нет активного плана`), чтобы переключение было видно без открытия сайдбара.

## 5. Тесты

- `PlanStore`: сессионные слоты изолированы (`save/load/clear` по двум id не пересекаются); fallback legacy усыновляет; `clearSessionActive` на несуществующем — no-throw.
- `ExecutionModule.switchSession`: A(create plan)→B(пусто)→A(план вернулся); B создаёт свой — A цел; `setPlan` в B не трогает A.
- Web: `handleSessionActivate` зовёт `switchSession`; `handleSessionCreate` — тоже; `DELETE` чистит слот.
- REPL `/resume`/`/new` — вызов `switchSession` (через `agent.getModule`).
- Существующие `bun test` + `tsc --noEmit` зелёные.

## 6. Риски

- Два `mma` на одном `.mma` делят файлы планов как раньше (атомарная запись уже есть); per-session слоты только уменьшают коллизии.
- Путь `sessionId` в имя файла — санитизация обязательна (только `[A-Za-z0-9_-]`).
- `switchSession` во время хода (single-flight `busy` в web, синхронный REPL) — точки переключения вне хода; реентрантности нет.
