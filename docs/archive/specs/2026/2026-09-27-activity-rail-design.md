# Activity Rail — индикатор занятости агента над строкой ввода (web)

Дата: 2026-09-27
Статус: approved (устно), в работе
Ветка: `fix/chat-internal-diagnostics`
Демо (макеты): `docs/design/ui/loader-variants.html`, `docs/design/ui/demo-activity-rail-chat.html`

## 1. Проблема и цель

В web-UI во время хода есть только in-feed строка `.busy` (`✦ thinking · Ns · Esc`),
которая **исчезает при первом `text`-событии** и не показывает, чем агент занят,
когда модель молча думает или выполняет долгий тул. Рядом с композером во время
хода нет вообще никакого индикатора: пользователь видит замерший экран.

**Цель:** крупный, но компактный индикатор общей занятости агента **над строкой
ввода**, который живёт весь `busy`-период и честно показывает то, что мы реально
знаем: фазу,.elapsed, прогресс плана (только если план есть), счётчик тулов и
последнее событие.

**Ключевое ограничение:** точного процента «занятости» не существует — мы не
знаем, сколько осталось. Поэтому без плана полоса **indeterminate** (сканер),
а не фейковый прогресс. Это решение принято явно (обсуждение 2026-09-27).

## 2. Non-goals

- Не трогаем терминальный REPL (там свой `Spinner`, `ui.spinner`).
- Не расширяем `AgentPhase` (`thinking | "done"`) — фаза выводится на клиенте.
- Не добавляем новых SSE-событий и эндпоинтов: только уже существующие
  `state`/`phase`/`tool_start`/`tool_end`/`text`/`plan`/`turn_end`.
- Не заменяем in-feed строку `.busy` — она остаётся (локальный статус в ленте),
  rail добавляется как общий индикатор у поля ввода.
- Не показываем выдуманные проценты, ETA и «занятость» без источника.

## 3. UX

### 3.1 Раскладки (`ui.activityRail`)

| Значение | Вид |
| --- | --- |
| `line` (**default**) | Одна строка над композером: полоса 180px слева + мета справа |
| `meta` | Полоса 110px прямо в строке подсказок `.inp-meta` (рядом с `Enter — send`), мета схлопнута до фазы и таймера |
| `full` | Полоса во всю ширину, мета двумя строками (наиболее информативный, для широких экранов) |
| `off` | Рейка выключена |

DOM один и тот же; раскладка меняет класс `l-line | l-meta | l-full` и (для
`meta`) перемещает узел в `.inp-meta`. Смена раскладки не перезагружает страницу.

### 3.2 Режимы полосы

- **`scan` (нет плана)** — индeterminate: светящийся сегмент (30% ширины)
  сканирует полосу слева направо. Скорость от фазы: `thinking` 1.7s,
  `tool` 1.0s, `composing` 1.3s на цикл.
- **`plan` (есть план)** — полоса заполняется по `done/total`
  (`steps.filter(status==="done").length / steps.length`), засечки на границах
  шагов. Источник: SSE `plan` и `host.plan` из `/api/state`.
- Переключение режима в середине хода поддерживается (MoE может прислать план
  позже); при исчезновении плана — обратно в `scan`.

### 3.3 Мета-строка

`✦ <фаза> · <elapsed> · <шаг k/N | без плана> · <N тулов> · <N событий> · последнее: <имя тула>`

- Фаза: `thinking` → «размышляю/dumaю» (ключ `web.action.thinking`),
  `tool` → «выполняю/working», `composing` → «пишу/composing».
- `Esc — стоп` дублируется **только в `full`-раскладке**; в `line`/`meta` эта
  подсказка уже есть в `.inp-meta` и не дублируется.
- В `meta`-раскладке строки «тулы/события/последнее» скрыты (место в подсказках
  ограничено), остаются фаза и таймер.

### 3.4 Вспышка (activity flash)

Каждое реальное событие (`tool_start`, `tool_end`, `text`, `plan`) даёт
короткую вспышку полосы (450ms, `box-shadow` + `brightness`) и увеличивает
счётчик событий; последнее событие записывает локализованное имя тула.
`text`-события идут буферизованными чанками (~350ms, `forward.ts`) — частота
вспышек естественным образом ограничена.

### 3.5 Жизненный цикл

- **busy →** rail показывается, таймер стартует, счётчики обнуляются;
  полушаг: `POST /api/message` (202) → показ сразу, как и `.busy`.
- **idle →** rail скрывается полностью (`hidden`), композер выглядит обычно.
- Триггеры: `S.state.busy` (SSE `state`, поллинг `/api/state`, `onTurnEnd`).

### 3.6 Доступность и reduced motion

- Корень: `role="status" aria-live="polite"`; **таймер и счётчики —
  `aria-hidden="true"`** (иначе скринридер будет читать их каждые 100ms).
  Объявляется только смена фазы (текст `.rail-l1 .lab`).
- Глобальное правило `prefers-reduced-motion: reduce` в `styles.css` уже
  отключает все анимации: сканер замирает (статичная приглушённая полоса),
  вспышка не играет. Явный CSS под `no-motion` не требуется.
- Rail не зависит от `ui.verbosity` (это статус, а не деталь) и не пишет в
  ленту; в `quiet`-режиме остаётся.

## 4. Источники данных (без изменений бэкенда)

| Поле | Источник |
| --- | --- |
| busy | `S.state.busy` (SSE `state`, `/api/state` 2s, `onTurnEnd`) |
| elapsed | переход `false → true` у `S.state.busy` (клиентские часы) |
| phase | вывод: `tool` если есть незакрытый `tool_start`; иначе `composing` если приходил `text` в этом ходу; иначе `thinking` |
| plan | `data.steps` из SSE `plan` / `host.plan` (`renderPlan` тот же объект) |
| tools | количество `tool_end` за ход |
| events | счётчик `tool_start|tool_end|text|plan` за ход |
| last event | `labelOf(name)` тула из последнего `tool_*` (тот же mapping, что в ленте) |

`phase: "done"` от сервера ходу не мешает: активность сбрасывается по
`turn_end`/`busy=false`, а не по фазе.

## 5. Архитектура

```
index.html   static-разметка .rail-wrap внутри .input-area (первый ребёнок)
styles.css   секция «activity rail» (~70 строк): трек, заливка, сканер,
             вспышка, раскладки l-line/l-meta/l-full, режим plan/scan
js/rail.js   новый модуль (ESM), владелец состояния rail;
             имена тулов берутся из `./format.js` (`labelOf`) — тот же
             источник, что использует лента (без дублирования mapping)
app.js       импорт rail + подписка на SSE-подсобытия + вызовы из handlers
js/tabs.js   reflectBusy() дополнительно дёргает rail.setBusy()
```

**`js/rail.js` API:**

```js
export function initRail(layout)      // создать/переместить узел, применить раскладку
export function setLayout(layout)     // "off" | "line" | "meta" | "full"
export function setBusy(busy)         // показать/скрыть, сбросить счётчики
export function railEvent(kind, name) // "tool_start"|"tool_end"|"text"|"plan"
export function setPlan(plan)         // {steps, currentIndex} | null
export function applyRailI18n()       // пере-локализация при смене locale
```

Внутри — один `setInterval(250ms)`: рендер таймера и чтение `S.state.busy`
(страховка: rail не рассинхронизируется, если событие потерялось).
Модуль не импортирует `app.js`/`tabs.js` (DAG остаётся ацикличным:
app → rail; app → tabs → rail).

**Wiring в `app.js`:** в `connectSSE()` рядом с таблицей `handlers` — второй
цикл подписки rail'а на те же события (`phase` не нужен, он не влияет на rail;
`state`/`turn_end` — через `setBusy`). Локализация: `hooks.applyStaticI18n`
дополняется вызовом `applyRailI18n()`.

## 6. Конфигурация

Ключ `ui.activityRail` (домен `ui`, `valueType: "enum"`, `reconfigure: false`):

- `src/config/types.ts` → `UiConfig.activityRail: "off" | "line" | "meta" | "full"`
- `src/config/defaults.ts` → `"line"`
- `src/config/registry-extra.ts` → `enumOf("ui.activityRail", "ui", ["off","line","meta","full"], false, get, set)`
- web settings → панель `ui.chat` (`settings-controls.js:424`), рядом с `ui.spinner`
- `/config ui.activityRail line` работает автоматически через реестр
- читается в `loadConfig()` (web) и применяется при старте + при смене ключа
  (poll `/api/config` в settings — существующий путь)

## 7. i18n (en + ru, паритет обязателен)

| Ключ | en | ru |
| --- | --- | --- |
| `web.rail.working` | working | выполняю |
| `web.rail.composing` | composing | пишу |
| `web.rail.no_plan` | no plan | без плана |
| `web.rail.step_of` | step {cur}/{total} | шаг {cur}/{total} |
| `web.rail.last` | last: | последнее: |
| `web.rail.tools_one/_few/_many` | {count} tool(s) | {count} тул/тула/тулов |
| `web.rail.events_one/_few/_many` | {count} event(s) | {count} событие/события/событий |
| `config.key.ui.activityRail` | activity rail | рейка активности |
| `config.desc.ui.activityRail` | Indicator above the input line while the agent works. | Индикатор над строкой ввода, пока агент работает. |
| `n.off` / `n.line` / `n.meta` / `n.full` | off / line / meta / full | выкл. / строка / подсказки / во всю ширину |

Фаза `thinking` переиспользует существующий `web.action.thinking`.
`Esc` — существующий `web.input.esc`.

## 8. Граничные случаи

- **Reconnect SSE** — счётчики не восстанавливаются (их нет на сервере); после
  `resyncAfterReconnect()` rail просто следует `busy`-состоянию. Допустимо.
- **Смена вкладки/сессии** — rail глобален для процесса (как композер), не
  привязан к табу; состояние хода общее.
- **Смена locale** — `applyRailI18n()` перерисовывает подписи; структура DOM
  неизменна.
- **`ui.activityRail = off`** — узел скрыт, интервал останавливается.
- **Пустой/битый `plan`** (нет `steps`) → режим `scan` (как у `renderPlan`).
- **`finish_reason: length`/ошибка хода** — rail гаснет по `busy=false`,
  независимо от исхода.

## 9. Тесты

- `tests/webui-assets.test.ts` — source-guard'ы (стиль существующих тестов):
  - разметка `.rail-wrap` в `index.html`, CSS `.rl-track`/`l-line`/`data-mode`;
  - wiring: `rail` импортируется в `app.js`, подписка `tool_start`/`text`/`plan`;
  - конфиг: `ui.activityRail` присутствует в HTML/JS панели настроек.
- `tests/i18n-*.test.ts` (существующая проверка паритета en/ru) — новые ключи.
- Реестр: существующие тесты валидации `/config` покрывают enum автоматически
  (добавить кейс в ближайший config-тест с перечислением ключей `ui.*`).
- Ручная проверка: `bun run web:dev` → сценарий с тулами + с планом MoE;
  Playwright e2e — **только по явной команде** (AGENTS.md).

## 10. Три измерения (Engineering Principles)

- **Реальный пользователь:** один предсказуемый индикатор у поля ввода, живёт
  весь ход, не исчезает после первого токена; выключается одним ключом;
  сообщения локализованы; reduced-motion не сломан.
- **ИИ-модель:** rail — чисто клиентский, в контекст модели не попадает;
  никаких новых tool-output/промпт-изменений.
- **Смежные модули:** бэкенд не меняется; `feed.js` не меняется (кроме
  отсутствия надобности); реестр конфига и web settings расширяются
  добавляемыми записями; DAG фронтенда не циклится; e2e-селекторы не
  конфликтуют (новые классы).

## 11. Приёмка

1. `bun run quality` зелёный, `bun test` зелёный.
2. При `busy` rail виден во всех трёх раскладках; при `idle` — скрыт.
3. Без плана — только сканер (никаких процентов); с планом — fill `done/total`
   и засечки.
4. Каждое `tool_*`/`text`/`plan` даёт вспышку и двигает счётчики.
5. `/config ui.activityRail off` скрывает rail без перезагрузки страницы.
6. en/ru: подписи локализованы, паритет ключей соблюдён.
