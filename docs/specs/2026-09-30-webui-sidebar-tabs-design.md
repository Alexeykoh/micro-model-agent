# Web UI Sidebar Tabs — Session / Map / Trace

Дата: 2026-09-30
Статус: approved (визуально), в работе
Ветка: `feat/webui-sidebar-tabs`
Макеты: `.superpowers/brainstorm/sidebar-tabs/content/02-real-ui.html`,
`04-trace-detail.html`, `05-trace-full.html` (собраны на реальном `styles.css`)

## 1. Проблема и цель

Сайдбар `mma web` — три всегда видимые сворачиваемые секции (`plan`, `session · usage`,
`environment`) в одном вертикальном потоке. Он плоский: нет места добавить что-то
новое, не раздувая поток; индекс карты проекта и происходящее во время хода
(какие тулы вызваны, что упало) вообще не видны — только лента чата.

**Цель:** превратить сайдбар в набор **вкладок** с иконками сверху, которые
переключают содержимое:

- **Session** — текущие `plan` / `session · usage` / `environment` (без изменений);
- **Map** — состояние индексации карты проекта (статус, время обновления, вотчер,
  счётчики, корень, разбивка по языкам, кнопка переиндексации);
- **Trace** — живой лог событий хода (тулы, фазы, план, ошибки, текст, вопросы)
  с master-detail: клик по строке раскрывает сайдбар вдвое и показывает детали.

## 2. Non-goals

- Не трогаем терминальный REPL и `OutputChannel` — это чисто web-UI.
- Не меняем SSE-контракт существующих событий (`state`/`text`/`meta`/`phase`/
  `tool_start`/`tool_end`/`plan`/`turn_end`/`question`/`error`) — Trace строится
  на них как есть.
- Не добавляем новых `AgentPhase` и не пишем Traces в `session.jsonl`.
- Не заменяем и не дублируем activity rail (`js/rail.js`) — он остаётся у композера.
- Не показываем Trace на мобильных (сайдбар там — drawer); вкладка и её панель там
  скрыты.
- Не добавляем синтаксический/LLM-анализ событий — только честный дамп того, что
  уже приходит по SSE.

## 3. UX

### 3.1 Панель вкладок (сверху сайдбара)

- Ряд квадратных кнопок-иконок 34×34 (равные стороны), gap 6px, padding 10px 14px,
  нижняя граница секции.
- Активная: `color: var(--accent)`, `background: var(--accent-bg)`, без бордера;
  неактивная: `border: 1px solid var(--border-2)`, `color: var(--stab-fg)`.
- Иконки — инлайн-Lucide (MIT) из `ICONS` (`js/dom.js`):
  - Session — `list-checks` (список с галочками),
  - Map — `map`,
  - Trace — `activity` (пульс).
- **Название активной вкладки — НЕ на табе, а строкой под табами** (`.sb-name`:
  иконка + локализованное имя, `font-weight:600`, нижняя граница). Это и требование
  пользователя, и доступность (иконка не объясняет себя).

### 3.2 Session

Панes — существующие `.sec` (`plan-sec` / `usage-sec` / `env-sec`) без изменений:
разметка, `renderPlan`/`renderUsage`/`renderEnvironment` остаются. Меняется только
вложение: они теперь внутри `.sb-pane[data-pane=session]`.

### 3.3 Map

Секции внутри панели:

- **index**: `status` (ready / indexing… / stale), `updated` (дата-время последней
  сборки индекса), `watcher` (on/off), `files`, `symbols`, `tokens`, `root`.
- **languages**: разбивка по языкам (`{lang} · N files · M sym`), топ-8.
- Кнопка **↻ Re-index** (`POST /api/index`) — ручной `refresh()` индексатора.
  Во время работы — disabled + подпись «индексирую…», статус `indexing`.
- `updated` форматируется на клиенте: сегодня → `today, HH:MM`; иначе `DD.MM HH:MM`;
  нет данных → `never`.

### 3.4 Trace

**Лента** (левая колонка внутри панели) — по одной строке на событие, группировка
по ходу (разделитель «turn N»):

| Тип | Глиф/цвет | Строка |
| --- | --- | --- |
| вызов тула | `◇` + цвет категории (recon/mutate/execute/meta) | `<label> · <args> · <time>` |
| провал тула / `error` | `⚠` yellow | `<label> · <first line> · <time>` |
| фаза | `✦` think | `thinking` / `composing` / … (`phase`) |
| план | `◇` meta | `plan update · step k → done` |
| текст | `✦` think + пульс-точка | одна **обновляющаяся** строка `печатает… · N chars` |
| вопрос | `?` meta | `question · <текст>` |

- Буфер — массив в памяти на **сессию**; при смене активной сессии очищается;
  при перезагрузке страницы теряется (осознанно, per approved).
- Кап буфера — 500 записей (старые отбрасываются), DOM не разрастается бесконечно.
- Стрим текста не плодит строки: одна запись на ход, обновляется на месте.

**Master-detail:**

- Клик по строке → `.sb` получает класс `sb-expanded` (ширина 680px, `transition:
  width .22s ease`), справа открывается панель деталей (**Вариант A**, approved:
  список уезжает влево, детали — у правого края).
- Повторный клик по выбранной строке, `✕` в шапке деталей или `Esc` — сворачивание
  и снятие выделения.
- Детали содержат: **metadata** (status, duration, time, tool call id, session),
  **arguments** (полный JSON / команда), **output** (полный вывод тула, скроллируемо;
  серверный кап 6–16K с маркером `… [truncated from N chars]`). Для нетуловых
  событий — своё тело (текст, шаги плана, вопрос+опции, reasoning фазы).

### 3.5 Поведение

- **Default:** Session.
- **Память:** последняя вкладка в `localStorage["mma-sidebar-tab"]`; если на мобильном
  сохранена `trace` — принудительно Session (Trace там нет).
- **Индикаторы:**
  - Trace: пульс-точка при `busy` (активность идёт);
  - Map: точка `indexing` (accent) во время переиндексации / `stale` (yellow),
    если индекс построен, но вотчер off (карта больше не обновляется автоматически).
- **Горячие клавиши:** `Alt+1` / `Alt+2` / `Alt+3` → Session / Map / Trace.
  Игнорируются, когда фокус в `INPUT`/`TEXTAREA`, чтобы не ломать ввод.
- **Переключение без сброса:** панели остаются в DOM (`hidden`), скролл и выбранное
  событие Trace сохраняются.

### 3.6 Доступность и reduced motion

- Панель вкладок: `role="tablist"`, табы — `<button role="tab" aria-selected>`,
  панель — `role="tabpanel"`; `aria-controls`/`aria-labelledby`.
- Клик / Enter / Space на табе; стрелки `←/→` циклично переключают.
- Точки-индикаторы — `aria-hidden`; статус индексации объявляется через текст Map
  (существующий `role="status"` на `.sb` не требуется, но `#live` не трогаем).
- `prefers-reduced-motion: reduce` (существующий kill-switch в `styles.css`) гасит
  анимацию ширины и пульс — уже покрыто глобальным правилом.

## 4. Источники данных

| Поле | Источник |
| --- | --- |
| активная вкладка | клиент (`localStorage`) |
| Trace-события | SSE `tool_start`/`tool_end`/`phase`/`plan`/`text`/`question`/`error` |
| Trace turn-разделители | SSE `turn_end` (закрывает ход) |
| Map status/counts/languages/updated/watcher | `/api/state` → `HostStateSnapshot.projectMap` (расширен) |
| Re-index | `POST /api/index` (новый) |

`projectMap` (обобщён до `ProjectMapInfo`, см. §6) едет в обычном 2s-поллинге
`/api/state`; после `POST /api/index` сервер шлёт `state`-событие по завершении.

## 5. Архитектура

```
index.html     .sb-tabs + .sb-name + три .sb-pane (session/map/trace)
styles.css     секция «sidebar tabs»: .sb-tabs/.sb-tab/.sb-name/.sb-pane,
               .sb.sb-expanded (ширина+transition), .trace/.trc, .detail*,
               media ≤760px скрывает trace-таб и trace-панель
js/sidebar.js  новый leaf-модуль: вкладки, Trace-буфер, master-detail, Map-рендер
app.js         import sidebar; boot initSidebar(); SSE-подписка Trace;
               renderState → sidebarMapState/sidebarSessionChanged;
               applyStaticI18n → applySidebarI18n(); hotkeys Alt+1..3
```

**`js/sidebar.js` API:**

```js
export function initSidebar()                 // DOM-refs, restore localStorage, bind tabs/hotkeys
export function setSidebarTab(id)             // "session" | "map" | "trace"
export function sidebarSessionChanged(sid)    // смена сессии → очистить Trace-буфер
export function sidebarMapState(host)         // host.projectMap → рендер Map
export function sidebarTraceEvent(kind, data) // добавить/обновить запись Trace
export function sidebarTurnEnd()              // закрыть текущий ход (разделитель)
export function sidebarBusy(on)               // индикатор Trace (пульс при busy)
export function sidebarMapIndicator(host)     // индикатор Map (indexing/stale)
export function applySidebarI18n()            // пере-локализация при смене locale
```

Модуль импортирует только `dom.js`, `i18n.js`, `format.js` — DAG ацикличен
(`app → sidebar → {dom,i18n,format}`).

**SSE-подписка Trace** — отдельный цикл в `app.js` (как у rail), feed-хендлеры
не трогаются:

```js
for (const ev of ["tool_start", "tool_end", "phase", "plan", "text", "question"]) {
  es.addEventListener(ev, (e) => { const d = parse(e); if (d) sidebarTraceEvent(ev, d); });
}
es.addEventListener("error", (e) => { if (e.data) { const d = parse(e); if (d) sidebarTraceEvent("error", d); } });
```

## 6. Изменения бэкенда

### 6.1 Контракт (`src/core/host.ts`)

```ts
export interface ProjectMapLanguage { language: string; files: number; symbols: number; }
export interface ProjectMapInfo {
  indexed: boolean;
  /** Идёт обход прямо сейчас. */
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

`HostStateSnapshot.projectMap?: ProjectMapInfo` (было `{indexed,files,symbols,tokens}` —
совместимо: расширение).

### 6.2 Индексатор (`src/modules/indexer/module.ts`, `cache.ts`)

- `IndexerModule`: поля `private indexing = false`, `private builtAt: number | null`,
  `private watcherActive = false`.
- `buildIndex()`/`refresh()`: `indexing=true` вокруг обхода, `builtAt=Date.now()` при
  установке индекса, `finally { indexing=false }`.
- `watch()` → `watcherActive=true`; `unwatch()` → `false`.
- Новый метод `mapInfo(): ProjectMapInfo` — считает `languages` из `index.files`
  (группировка по `language`, топ-8 по files), возвращает текущие счётчики +
  `updatedAt`/`watcher`/`indexing`. Кэшируется на объект индекса рядом со `stats()`.
- `stats()` остаётся (используется тестами), реализуется через `mapInfo()`.
- `cache.ts`: `CacheEnvelope.builtAt?: number` (optional, обратная совместимость);
  `save()` пишет `Date.now()`, `load()` пробрасывает в `IndexResult`-обёртку →
  `builtAt` берётся из кэша, иначе `Date.now()`. `CACHE_VERSION` не бампаем
  (optional-поле не ломает старый кэш).

### 6.3 Проекция и роут

- `host-state.ts`: `WebIndexer` расширяется `mapInfo(): ProjectMapInfo` и
  `refresh(): Promise<unknown>`; `HostStateInput.projectMap?: ProjectMapInfo`.
  `buildHostState` пробрасывает объект как есть.
- `module.ts` `getState()`: `projectMap: deps.indexer?.mapInfo?.() ?? undefined`.
  Плюс `state.refreshIndex = () => deps.indexer?.refresh?.() ?? Promise.resolve()`.
- `state.ts`: `WebUiState.refreshIndex?: () => Promise<void>`.
- `server.ts` `API_ROUTES`: `"POST /api/index"` → `handleIndexPost` (auth + same-origin
  уже проверены общим путём): fire-and-forget `s.refreshIndex?.()`, по завершении
  `broadcast({type:"state", ts, busy:s.busy, usage:s.usage})`; сразу `202 {ok:true}`.
  Если `refreshIndex` не задан — `503 {error:"unavailable"}`.

## 7. i18n (en + ru, паритет обязателен)

| Ключ | en | ru |
| --- | --- | --- |
| `web.sidebar.tab_session` | Session | Сессия |
| `web.sidebar.tab_map` | Map | Карта |
| `web.sidebar.tab_trace` | Trace | Трассировка |
| `web.sidebar.map_status` | status | статус |
| `web.sidebar.map_ready` | ready | готово |
| `web.sidebar.map_indexing` | indexing… | индексация… |
| `web.sidebar.map_stale` | stale | устарело |
| `web.sidebar.map_updated` | updated | обновлено |
| `web.sidebar.map_never` | never | никогда |
| `web.sidebar.map_today` | today, {time} | сегодня, {time} |
| `web.sidebar.map_watcher` | watcher | вотчер |
| `web.sidebar.map_on` / `map_off` | on / off | вкл. / выкл. |
| `web.sidebar.map_files` / `map_symbols` / `map_tokens` | files / symbols / tokens | файлы / символы / токены |
| `web.sidebar.map_root` | root | корень |
| `web.sidebar.map_languages` | languages | языки |
| `web.sidebar.map_reindex` | Re-index | Переиндексировать |
| `web.sidebar.map_reindexing` | re-indexing… | переиндексация… |
| `web.sidebar.map_reindex_failed` | re-index failed | не удалось переиндексировать |
| `web.sidebar.trace_empty` | no events yet | событий пока нет |
| `web.sidebar.trace_turn` | turn {n} | ход {n} |
| `web.sidebar.trace_text` | composing… {count} chars | печатает… {count} симв. |
| `web.sidebar.trace_plan` | plan update | обновление плана |
| `web.sidebar.trace_question` | question | вопрос |
| `web.sidebar.detail_metadata` | metadata | метаданные |
| `web.sidebar.detail_arguments` | arguments | аргументы |
| `web.sidebar.detail_output` | output | вывод |
| `web.sidebar.detail_error` | error | ошибка |
| `web.sidebar.detail_text` | text | текст |
| `web.sidebar.detail_plan` | plan | план |
| `web.sidebar.detail_reasoning` | reasoning | размышление |
| `web.sidebar.detail_status` | status | статус |
| `web.sidebar.detail_ok` / `detail_fail` | ok / failed | ok / ошибка |
| `web.sidebar.detail_duration` | duration | длительность |
| `web.sidebar.detail_time` | time | время |
| `web.sidebar.detail_tool_call` | tool call | вызов тула |
| `web.sidebar.detail_session` | session | сессия |

Фазы и тул-ярлыки переиспользуют существующие `web.action.thinking`,
`web.rail.working`/`web.rail.composing`, `tool.friendly.*` (через `labelOf`).

## 8. Граничные случаи

- **Нет индексера** (`deps.indexer` не задан): Map показывает `status: never`,
  счётчики `—`, кнопка Re-index отключена; `POST /api/index` → `503`.
- **Индекс не построен**: `indexed:false` → Map рисует `never` + `0`, не падает.
- **Битый/частичный `tool_end`** (нет `output`) → детали показывают пустой output.
- **SSE reconnect**: Trace-буфер не восстанавливается (живёт в памяти); после
  reconnect лента продолжает с нуля — допустимо (per approved scope).
- **Смена сессии/таба** (web `switchSession`): `sidebarSessionChanged(sid)` чистит
  буфер и схлопывает detail.
- **Мобильный drawer**: `@media (max-width:760px)` скрывает Trace-таб и его панель;
  если сохранена `trace` — переключение на Session.
- **`localStorage` недоступен** (приватный режим) → тихий fallback на Session.
- **Очень длинная строка деталей**: `output`/`arguments` — `white-space: pre-wrap;
  overflow-wrap: anywhere`, контейнер скроллится.
- **reduced-motion**: анимация ширины и пульс выключены глобальным правилом.

## 9. Тесты

- `tests/indexer-module.test.ts` — `mapInfo()`: `updatedAt` после `refresh()`,
  `languages` (группировка/топ-8), `watcher` false→true после `watch()`, `indexing`
  во время обхода.
- `tests/modules/indexer/cache.test.ts` — `builtAt` пишется в конверт и читается
  из старого конверта (без поля) как null/now.
- `tests/webui-usage.test.ts` — `buildHostState` пробрасывает `ProjectMapInfo`.
- `tests/webui-server.test.ts` — `POST /api/index`: 202 при заданном `refreshIndex`,
  503 без него, 401 без auth.
- `tests/webui-assets.test.ts` — source-guard: `.sb-tabs`/`.sb-name`/`.sb-pane` в
  `index.html`; `js/sidebar.js` отдаётся через `loadAssets`; wiring в `app.js`
  (импорт + подписка `tool_start`/`text`); CSS `.sb-expanded`/`.sb-tab`.
- `tests/i18n.test.ts` — паритет en/ru новых ключей `web.sidebar.*`.
- Ручная проверка: `bun run web:dev` — все три вкладки, Trace с реальным ходом
  (tool/phase/plan/text/question), master-detail, реиндексация; мобильная ширина.
  Playwright e2e — **только по явной команде** (AGENTS.md).

## 10. Три измерения (Engineering Principles)

- **Реальный пользователь:** вкладки с понятными иконками и подписью активной;
  Trace даёт честную картину хода и детали по клику; Map даёт контроль над индексом
  и его свежестью; горячие клавиши; память выбора; reduced-motion.
- **ИИ-модель:** ноль влияния на контекст модели — всё клиентское + расширение
  host-снапшота; новых тулов/промптов нет.
- **Смежные модули:** SSE-контракт не меняется; activity rail не затронут;
  `HostStateSnapshot.projectMap` — аддитивное расширение (обратно совместимо);
  `stats()` сохранён; e2e-селекторы не конфликтуют (новые классы); `build:prod`
  копирует `js/sidebar.js` автоматически (тот же `js/`-каталог).

## 11. Приёмка

1. `bun run quality` и `bun test` зелёные (`tsc --noEmit`, Biome, fallow).
2. В сайдбаре сверху три квадратные иконки-таба; под ними — имя активной вкладки.
3. Session без регрессий; Map показывает статус/время/вотчер/счётчики/языки/корень,
   Re-index работает; Trace живёт per-session и наполняется реальными событиями.
4. Клик по событию плавно расширяет сайдбар вдвое и показывает метаданные,
   аргументы и вывод; `Esc`/`✕`/повторный клик сворачивают.
5. На ≤760px Trace-вкладки нет; Session/Map работают в drawer.
6. en/ru: все новые строки локализованы, паритет ключей соблюдён.
7. `CHANGELOG.md` и `AGENTS.md` обновлены; версия — MINOR.
