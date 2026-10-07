# Plugin Registry: метаданные, вкл/выкл, вкладка Plugins в сайдбаре — Design

Дата: 2026-10-07
Статус: **фазы 1–6 реализованы**
Ветка: `feat/plugin-registry`
Тип релиза: MINOR (аддитивные поля, новые хуки, новые REST-роуты, новая вкладка; ломающих
изменений публичного plugin API нет)

## Статус фаз

| Фаза | Что | Состояние |
|------|-----|-----------|
| 1 | Метаданные и `PluginRecord` | ✅ `dd8e1db` |
| 2 | Живой вкл/выкл | ✅ `dd8e1db` |
| 3 | Web: REST + вкладка Plugins | ✅ `6618e0f` |
| 4 | Живой reload (`onUnload`, сброс кэша, `/reload`) | ✅ `6b74721` |
| 5 | Тулы от плагинов (`getToolDefinitions`) | ✅ реализована |
| 6 | Черновики + `define_capability` | ✅ реализована |

Фазы 1–6 смержились независимо и покрыты тестами (`bun test` 3423 pass, `bun run quality`
exit 0). Проверено вживую на запущенном `mma web`: правка файла плагина + перезагрузка
подхватывает новый код **без перезапуска процесса**.

### Что учитывать при продолжении (фаза 6)

1. **`require`-кэш проверен экспериментом, не предположением.** `delete require.cache[…]` под
   Bun работает и для `.ts`, и для `.js`; под Node — только для `.js` (transpile кэшируется
   отдельно). Отсюда счётчик `staleTs` в `ReloadReport`: под Node `.ts`-плагины после reload
   сохраняют старый код, и UI/CLI об этом говорят явно. Это ограничение Node, а не дыра в
   реализации — не «чините» его допущением, проверка уже выполнена.
2. **Порядок reload обязателен:** выгрузка (с `onUnload`) → сброс кэша → чтение. Иначе старый и
   новый экземпляр живут одновременно, а дедуп по имени выкидывает новый.
3. **Менеджер владеет своими каталогами** (`setSourceDirs` на bootstrap) — CLI, REPL и веф
   зовут `PluginManager.reload()` и не знают про пути. Не заводите вторую копию правды о путях.
4. **`manager.ts` уже на пределе:** диспатчер хуков вынесен в `plugins/dispatch.ts`. Новое
   по регистру — в `records.ts` / `tools.ts` / `reload.ts`, не в менеджер.
5. **Клоны реестра живут под `PluginManager` (фаза 5, решение).** Вместо «владельца набора
   реестров в bootstrap» набор реестров держит сам менеджер (`attachToolRegistry` /
   `detachToolRegistry`), а `buildRunnerPlugins` делит с главным **общий deny-list**
   (`shareGateWith` → общий объект-гейт с `peers`). Следствия, которые не сломать:
   - `setDisabledAll` правит множество **на месте** (подмена объекта тихо оставила бы раннеры
     со старым deny-list), а `getRecords()` сверяется с `gate.version` — общий инвалидатор;
   - изменение из одного менеджера чинит реестры **всех** менеджеров гейта (`syncGatePeers`),
     иначе тумблер в вебе гасил бы плагин только в главном агенте;
   - остановка раннера обязана звать `runner.dispose()` → `detachToolRegistry`, иначе менеджер
     держит реестр выключенной сессии (утечка + внос тулов после reload).
   Состояние «кто внёс тул» лежит в `WeakMap<ToolRegistry, …>` внутри `plugins/tools.ts`, а не
   в менеджере: реестров много, у каждого свой набор.
6. **Добавление тула ломает префикс промпта** (`agent.ts:958`) → сброс prompt-cache на
   следующем ходе плюс двойная плата (schema в `body.tools` и оценка бюджета каждый запрос).
   Предупреждение пользователя — часть дизайна, а не деталь: в поп-апе вкладки Plugins
   показывается dim-строка `web.plugins.cache_note` для плагинов с тулами.
   Имя тула в реестре — `plugin__<плагин>__<тул>` (как `mcp__<server>__<tool>`): префикс
   снимает коллизии с ядром и делает происхождение видно в истории. Отказ при конфликте
   отбрасывает **весь** вклад плагина, и то же — для невалидных определений.
7. **Не выдавайте `permissions` за защиту.** Код плагина исполняется в процессе агента; см. §8.1.

## 0. Цель и метод

Три связанных запроса:

1. **Плагин — зарегистрированная сущность с метаданными**, а не анонимный объект в массиве.
   Автор, версия, описание, homepage, «что добавляет», «какие права запрашивает» — и всё это
   видно и в CLI/REPL, и в вебе. Плюс единый read-модельный тип `PluginRecord` как единственный
   источник правды для всех поверхностей.
2. **Включение/выключение плагина** без «удали файл / переименуй файл». Живой тумблер, конфиг,
   CLI, REPL, веб.
3. **Вкладка Plugins в сайдбаре `mma web`** — список с тумблерами и поп-апом с подробностями
   (описание, автор, версия, путь, что добавляет, права, предупреждения загрузки).

Всё это — фундамент для конечной цели, обсуждавшейся в разборе: **категория meta-tools, где
агент пишет плагин сам**. Реализовано это фазой 6 (`define_capability`), а фазы 4–5 дают ей
техническую возможность. Порядок фаз выбран так, чтобы фазы 1–3 (сам запрос) были полезны сами
по себе, а 4–6 открывали дорогу к самоавторству.

Метод: инвентаризация существующей подсистемы плагинов, загрузчика, реестра конфига, фронтенда
сайдбара и guard-тестов; дизайн собран интерактивно с пользователем (состав метаданных,
модель вкл/выкл, форма поп-апа).

## 1. Инварианты (ломать нельзя)

1. **Обратная совместимость плагинов.** Плагин из 8 строк (`docs/plugins.md:15-25`) и оба примера в
   `examples/plugins/*` продолжают работать без правок. Отсутствие `author`/`description` —
   **предупреждение, не ошибка**. Единственное жёсткое требование к регистрации — валидный `name`
   (он и сейчас обязателен, `loader.ts:85`).
2. **Ошибка изоляции сохраняется.** Любой путь реестра (валидация метаданных, toggle, reload,
   сборка тулов) обёрнут в `safeInvoke`/`try-catch` — битый плагин не роняет bootstrap и не
   роняет петлю агента.
3. **`AgentPlugin` расширяется только опциональными полями и хуками.** Ни одно существующее
   поле не меняет смысл и тип. `PluginHook` (`src/tools/types.ts:217`) остаётся узким
   executor-контрактом.
4. **Единый путь записи.** Тумблер в вебе, `mma plugins enable`, `/plugins enable` и
   `/config plugins.disabled` пишут **только** через `setConfigValue` — эффекты применяются
   внутри него, а не в каждой поверхности отдельно (иначе REPL и web разъезжаются).
5. **Disable ≠ sandbox.** Честно фиксируем в доках и в UI: модуль уже `require`-нут, код
   верхнего уровня уже выполнился. Выключение отключает хуки и вклад плагина в тулы, но не
   отменяет исполнение импорта. Право выключения — это про поведение, не про изоляцию.
6. **Frontend-модуль — leaf.** `sidebar/plugins.ts` импортирует только `dom/api/i18n/store/
   subdialog/dialog` + `sidebar/state.js` (guard `tests/webui-frontend-graph.test.ts`).
7. **Backend-хендлеры зависят от ролей, не от `WebUiState`** (guard
   `tests/webui-boundaries.test.ts`); `WebPluginManager` расширяется, оставаясь структурной
   ролью, которую удовлетворяет `PluginManager` без изменений.
8. **i18n-паритет.** Все строки через `t()`, ключи в `en.json` **и** `ru.json`.
9. **STYLE.md.** Список плагинов — строки, отступы, глифы; никаких boxed-панелей. Системные
   имена тулов в чате не показываем (здесь это не чат, но тот же принцип: в UI — человеческие
   имена, `author`, версия).
10. **Правило ≤300 строк.** `manager.ts` (сейчас 251) не должен превратиться в god-object:
    метаданные/валидация/build-record выносятся в `plugins/records.ts`, вклад тулов — в
    `plugins/tools.ts`.
11. **Никаких eval/`-c`.** Ничего нового не исполняется интерпретатором: только существующий
    путь `require()` в `PluginLoader` и явный вызов хуков.

## 2. Текущее состояние (инвентаризация)

Что уже есть и на чём стоит:

- **Загрузка:** `builtin/` + `~/.mma/plugins/` (`src/config/paths.ts:59`) +
  `<baseDir>/.mma/plugins/` (`modules-phase.ts:196`); плоские файлы `.ts/.js` или папки с
  `plugin.ts > plugin.js > index.ts > index.js` (`loader.ts:13`); `require()` (`loader.ts:83`);
  ошибка импорта ловится и логируется, bootstrap выживает.
- **Интерфейс:** `AgentPlugin` (`src/modules/types.ts:53-93`) — 15 хуков, hooks-only.
- **Надёжное:** изоляция ошибок `safeInvoke` (`manager.ts:15-31`) с корректно прицепленным
  `.catch`; `onBeforeTool`/`onAfterTool` awaited и сериализованы `AsyncLock` (пережили
  параллельные сабтаски, `executor.ts:205-214`); приоритет + семвер-дедуп + `minMmaVersion` гейт.
- **Дёшево пишется:** минимальный плагин 8 строк; примеры — ноль зависимостей, duck-типают
  локальные интерфейсы.

Чего нет (и что добавляет эта спека):

| # | Пробел | Где | Фаза |
|---|--------|-----|------|
| 1 | нет `description`/`author`/`homepage`/`provides`/`permissions` | `modules/types.ts:53` | 1 |
| 2 | нет единой read-модели; три несинхронизированных «плагин-типа» | `modules/types.ts:53`, `tools/types.ts:217`, `webui/state.ts:87` | 1 |
| 3 | не загрузившийся плагин бесследно исчезает — «сломанных» не видно | `loader.ts:112` | 1 |
| 4 | нет enable/disable: ни конфига, ни API, ни метода в менеджере | — | 2 |
| 5 | `enabled: true` захардкожен в веб-ответе | `settings-api.ts:176` | 2 |
| 6 | нет `POST /api/plugins/:name` | `settings-api.ts:634-668` | 3 |
| 7 | нет вкладки Plugins, нет SSE `plugins`, нет `web.sidebar.tab_plugins` | — | 3 |
| 8 | `/reload` не чистит `require.cache` → правки кода не подхватываются | `repl.ts:326`, `loader.ts:83` | 4 |
| 9 | нет `onUnload` → перезагрузка течёт сокетами (`examples/plugins/web-ui`) | — | 4 |
| 10 | `SkillsModule` без `reload()` — навык, написанный агентом, требует рестарта | `skills/module.ts` | 4 |
| 11 | загруженный плагин **не может добавить тул** (нет `getToolDefinitions`) | `modules/types.ts:53` | 5 |
| 12 | `ToolRegistry.register` кидает на дубль, `unregister` нет | `tools/registry.ts:8` | 5 |
| 13 | web-раннеры клонируют реестр (`session-runner-scope.ts:40`) | — | 5 |
| 14 | `AgentPlugin`/`HostBridge`/`TurnSummary` не в публичном API пакета | `src/index.ts:16` | 5 |
| 15 | нет доверия/consent к загруженному коду | — | 6 |

Побочная находка: `sessionIsolation.isolatePlugins` объявлен (`config/types.ts:430`,
`registry-extra.ts:359`, `defaults.ts:177`), но **не читается нигде в `src/`** — мёртвый ключ.
Решается в фазе 2 (см. §5.2).

## 3. Модель плагина: метаданные

### 3.1 Поля `AgentPlugin`

```ts
/** Явные права, которые плагин просит у хоста. Только декларация + показа. */
export type PluginPermission =
  | "config:read"
  | "fs:read"
  | "fs:write"
  | "process"
  | "network"
  | "session:write";

/** Что плагин добавляет в харнесс. */
export interface PluginProvides {
  /** Имена тулов, которые плагин отдал через `getToolDefinitions()`. */
  tools?: string[];
  /** Имена реализованных хуков (вычисляется из интерфейса при регистрации). */
  hooks?: string[];
}

export interface AgentPlugin {
  // ...существующие поля без изменений...
  /** Человеческое описание (1–2 строки) — показывается в UI и в `mma plugins list`. */
  description?: string;
  /** Автор или организация. */
  author?: string;
  /** Домашняя страница/репозиторий. Только http(s). */
  homepage?: string;
  /** Права, которые плагин запрашивает. */
  permissions?: PluginPermission[];
  /** Что добавляет; `tools` заполняется ядром, `hooks` — вычисляется. */
  provides?: PluginProvides;
  /** Абсолютный путь к файлу плагина (проставляет загрузчик). */
  path?: string;
}
```

Новых **обязательных** полей нет — это и есть инвариант 1.

### 3.2 Валидация

`validatePluginMeta(plugin): { errors: string[]; warnings: string[] }` в
`plugins/records.ts`.

| Поле | Правило | Нарушение |
|------|---------|-----------|
| `name` | `^[a-z0-9][a-z0-9._-]{0,63}$` | **error** → не регистрируем |
| `version` | semver-совместим (переиспользуем `semverGt`-семантику) | warning, регистрируем |
| `author` | 1–80 символов, одна строка | warning (пусто) / warning (длиннее) |
| `description` | ≤ 400 символов | warning |
| `homepage` | URL с `http:`/`https:` | warning, значение отбрасывается |
| `permissions` | подмножество `PluginPermission` | warning, неизвестные отбрасываются |
| `provides.tools` | строки, уникальные | warning |

Ошибок на уровне `name` сегодня фактически нет (loader отбрасывает nameless), но добраться до
`register()` может плагин, зарегистрированный вручную из модуля, — гейт нужен.

Мягкие проверки пишем в лог **один раз на плагин** (`plugin.meta_warning`) и показываем в UI
как `warnings[]` — иначе предупреждения засорят каждый ход.

### 3.3 `PluginRecord` — единственная read-модель

```ts
export interface PluginRecord {
  name: string;
  version?: string;
  author?: string;
  description?: string;
  homepage?: string;
  source?: "builtin" | "global" | "project";
  builtin: boolean;
  /** Загружен из черновиковой (самоавторской) директории — фаза 6. */
  draft: boolean;
  enabled: boolean;
  /** Абсолютный путь к файлу (для внешних). */
  path?: string;
  loadedAt?: number;
  provides: { tools: string[]; hooks: string[] };
  permissions: PluginPermission[];
  warnings: string[];
  /** Плагин не загрузился: краткая причина (одна строка). */
  error?: string;
}

export interface PluginLoadFailure {
  /** Метка записи (`my-plugin/plugin.ts` или `foo.ts`). */
  entry: string;
  path: string;
  message: string;
  at: number;
}
```

`PluginManager.getRecords(): PluginRecord[]` — единственный источник для CLI, REPL и веба.
`getPluginInfos()`/`getPlugin(name)` остаются для обратной совместимости
(`executor.ts` использует `getAllPlugins()`).

`getRecords()` строит записи один раз и кэширует (невалидируем по событиям), пересобирает при
`register`/`setEnabled`/`reload`/появлении новой ошибки загрузки.

**Три типа-дубликата.** `WebPluginInfo`/`WebPluginManager` (`webui/state.ts:86-97`) заменяем на
импорт `PluginRecord` из модулей плагинов — web уже зависит от ядра, а `WebPluginInfo` сейчас
беднее ответа собственного API. `PluginHook` (`tools/types.ts:217`) **не трогаем**: это узкий
executor-контракт, и дублирование с `AgentPlugin` существует намеренно (executor не должен знать
про метаданные).

## 4. Включение и выключение

### 4.1 Семантика

- Модель: **deny-list** — `config.plugins.disabled: string[]`, дефолт `[]`. Allow-list отвергнут:
  он тихо выключил бы плагин, который пользователь только что положил в папку, и это плохо
  отлаживается.
- Выключенный плагин: не участвует в диспатчерах хуков, не вкладывает тулы, его `provides`
  остаётся видимым (иначе непонятно, что включить обратно), в UI — dim + тумблер off.
- Переключение **живое**, без `agent.reconfigure` и без рестарта: диспатчеры читают
  `PluginManager.disabled` на каждой итерации.
- Встроенные плагины тоже выключаемы. `notify`/`lint-on-write` — не священны: если мешает, его
  выключают. `minMmaVersion`-гейт остаётся.

### 4.2 Реализация в менеджере

Одна харнесс-точка вместо правки 15 диспатчеров:

```ts
private disabled = new Set<string>();

/** Активные плагины в порядке приоритета — единственная точка фильтрации. */
private active(): AgentPlugin[] {
  return this.plugins.filter((p) => !this.disabled.has(p.name));
}

setEnabled(name: string, on: boolean): boolean { /* false — плагина нет */ }
isEnabled(name: string): boolean { ... }
getDisabled(): string[] { ... }
```

Все `runOn*` и `getAllPlugins()` переключаются на `this.active()`. `getAllPlugins()` тоже
фильтрует — от него зависит `executor.ts:207` (`beforePlugins.some(p => p.onBeforeTool)`) и
`settings-api`; так выключенный блокирующий плагин действительно перестаёт блокировать.

Побочный эффект, который фиксируем в доках: выключение `lint-on-write` снимает
`onAfterTool`-правку результата; выключение любого `onBeforeTool`-плагина снимает гард. Это
запрошенное пользователем поведение, но оно должно быть видно в UI (§6.3).

### 4.3 Конфиг

`AppConfig.plugins?: PluginsConfig` (`config/types.ts`, опциональное гнездо по конвенции
`execution?`/`critic?`):

```ts
export interface PluginsConfig {
  /** Имена выключенных плагинов. */
  disabled?: string[];
}
```

- `config/defaults.ts`: `plugins: { disabled: [] }`.
- `config/domains.ts`: новый домен `plugins` → `~/.mma/config/plugins.json` (без записи в
  `CONFIG_DOMAINS` `saveDomainFiles` молча выкинет поле).
- `config/registry-extra.ts` (не `registry.ts` — тот grandfathered):

```ts
list("plugins.disabled", "agent",
  (c) => c.plugins?.disabled ?? DEFAULTS.plugins.disabled,
  (c, v) => { c.plugins ??= structuredClone(DEFAULTS.plugins); c.plugins.disabled = v as string[]; },
  { kind: "tags", placeholder: "my-plugin" }),
```

`list()` жёстко ставит `reconfigure: false` — это здесь **правильно**: эффект применяется не
через `agent.reconfigure`, а через site-effect (ниже).

- **Site-effect в `setConfigValue`** (по образцу `applyProviderModelMemory`,
  `registry.ts:647-660`): после `def.set` при `name === "plugins.disabled"` →
  `applyPluginConfigEffects(config, value)`, который вызывает `pluginManager.setEnabled` для
  каждого имени. Обе поверхности (REPL `mutateConfig` и web `/api/config`) получают эффект
  бесплатно — инвариант 4.

  Единственный сетевой путь, который это обходит, — `POST /api/plugins/:name`; он поэтому
  **не пишет файл руками**, а вызывает `setConfigValue` (§5.4).

- Валидация «имя существует в менеджерере» в реестре невыразима: `extraValidate(config, value)`
  не видит `PluginManager`. Неизвестные имена **не отвергаем** (иначе конфиг ломается при
  удалении плагина и не переносится между машинами) — но показываем в UI и в REPL
  `plugins.unknown_names` как dim-предупреждение.

### 4.4 Поверхности

- `mma plugins enable <name>` / `mma plugins disable <name>` — новые подкоманды рядом с
  `list` (`src/cli/plugin-commands.ts`), тот же путь `setConfigValue` + `saveConfig`.
- `/plugins` в REPL: расширенный вывод (см. §5.5) + `enable|disable <name>`.
- `/status`: строка активных плагинов (`repl.ts:1213`) начинает различать off (`–` + dim).

## 5. Backend

### 5.1 Разбиение модуля

`manager.ts` (251 строка) остаётся менеджером; новое выносится:

| Файл | Ответственность | ~строк |
|------|-----------------|--------|
| `src/modules/plugins/records.ts` | `PluginPermission`/`PluginProvides`/`PluginRecord`/`PluginLoadFailure`, `validatePluginMeta`, `buildRecord`, `detectHooks` | ~140 |
| `src/modules/plugins/tools.ts` | сбор и вклад тулов плагинов: санитизация имён, upsert/unregister, provenance | ~130 |
| `src/modules/plugins/manager.ts` | регистрация, dedup, enable/disable, диспатчеры, `getRecords`, reload-оркестрация | ~300 |

### 5.2 `PluginManager`: новая поверхность

```ts
register(plugin, source?): RegisterResult            // + warnings в RegisterResult (опционально)
getRecords(): PluginRecord[]
getFailures(): PluginLoadFailure[]
setEnabled(name, on): boolean
isEnabled(name): boolean
unregister(name): boolean                            // для reload
reload(opts?): ReloadReport                          // фаза 4
```

`RegisterResult` получает опциональное `warnings?: string[]` — обратная совместимость (потребитель,
который читает `status`, не ломается). Мёртвый вариант `"duplicate"` (объявлен `manager.ts:37`,
не возвращается, покрыт тестом как `skipped_older`) — **не трогаем в этой фазе**, отдельная
гигиена.

`getFailures()` заполняется загрузчиком (сейчас ошибка только в лог). Это ключевая UX-деталь:
сегодня сломанный плагин неотличим от отсутствующего.

### 5.3 `PluginLoader`: путь к файлу и «черновик»-слот

- `tryLoad` проставляет `plugin.path = fullPath` (нужно для UI и для reload).
- Загрузка путей не меняется, но добавляется третий источник `.mma/plugins/drafts/` —
  в фазе 6 (чтобы сейчас не плодить пустой каталог и `.gitignore`-обсуждение, слот резервируем
  только в фазе 6, а `PluginRecord.draft` вводим сейчас как всегда-`false` и вычисляем из
  пути).
- `loadFromDir` начинает возвращать `{ loaded, skipped, failed }` (сейчас — `void`), чтобы
  reload умел построить дифф.

### 5.4 REST (`mma web`)

`GET /api/plugins` — **аддитивное расширение** ответа, нынешние потребители
(`panels.ts:745`, тесты) не ломаются:

```jsonc
{
  "plugins": [ /* PluginRecord[] — `enabled` теперь настоящий */ ],
  "mcp": [ /* McpServerView[] — без изменений */ ],
  "failures": [ /* PluginLoadFailure[] */ ]
}
```

`handlePluginsGet` (`settings-api.ts:167`) перестаёт собирать view поле-в-поле и отдаёт
`getRecords()`; `enabled` больше не хардкод `true` (`:176`).

`POST /api/plugins/:name` — новая запись в `SETTINGS_PREFIX` (`settings-api.ts:634-668`),
зеркалит `handleMcpToggle` (`:195`), но **без** `restartRequired`:

```ts
/**
 * `POST /api/plugins/:name {enabled}` — живой тумблер плагина.
 * Пишет только через `setConfigValue("plugins.disabled", …)` — эффект
 * (PluginManager.setEnabled) применяется внутри setConfigValue.
 */
```

Контракт: `400 invalid-enabled` / `404 not_found` / `200 {ok, persisted, plugins, failures}`.
Ответ отдаёт свежие `plugins` — панель и вкладка перерисовываются без второго GET.

`POST /api/plugins/reload` — фаза 4; в фазе 3 не появляется.

SSE: `broadcast({ type: "plugins" }, s)` после toggle/reload. Клиент слушает
`es.addEventListener("plugins", …)` в `app.ts` и перечитывает `GET /api/plugins` (одна
источник правды — запись, не диффы; как `sessions`).

`WebPluginManager` (`webui/state.ts:94`) расширяется до:

```ts
export interface WebPluginManager {
  getRecords(): PluginRecord[];
  getFailures(): PluginLoadFailure[];
  setEnabled(name: string, on: boolean): boolean;
}
```

`PluginManager` удовлетворяет структурно; `PluginManager` остаётся единственной реализацией.

### 5.5 CLI / REPL вывод

`mma plugins list` и `/plugins` сейчас дублируют формат
`  {mark} {name}  v{version}  [{origin}]`. Один формат на двоих — одна функция
`formatPluginLines(records, { showBuiltin })` в `plugins/records.ts` (или тонкая обёртка в
`cli/plugin-format.ts`, чтобы UI-модуль не тянул CLI-i18n):

```
● my-plugin  v1.2.0  [project]  by alexe
    Post-commit linter · tools: lint_diff · perms: process, fs:read
✗ broken-plugin            [project]  plugin.skipped: Unexpected token
```

`mma plugins show <name>` — подробности (то же, что поп-ап в вебе, текстом).

## 6. Frontend: вкладка Plugins

### 6.1 Правки существующих файлов

| Файл | Правка |
|------|--------|
| `assets/js/sidebar/state.ts:7` | `TABS = [..., "plugins"]` (последним — `Alt+1..5` не сдвигаются) |
| `assets/js/sidebar/state.ts:8-14` | `ICON_NAME.plugins = "puzzle"` |
| `assets/js/sidebar/state.ts` | `PluginsView` + поле `plugins` в `SidebarState`/`sb` |
| `assets/js/sidebar/core.ts:31` | ленивый хук `if (effective === "plugins") sidebarPluginsState()` |
| `assets/js/sidebar/core.ts:40-55` | `renderPlugins()` в `applySidebarI18n` |
| `assets/js/sidebar/core.ts:93-99` | расширить whitelist хоткея до `"6"` |
| `assets/js/sidebar.ts` | `export * from "./sidebar/plugins.js"` |
| `assets/js/dom.ts` | запись `puzzle` в `ICONS` (инлайн SVG, Lucide, MIT — как остальные) |
| `assets/index.html:119-122` | кнопка `.sb-tab[data-tab="plugins"]` |
| `assets/index.html` | `#pane-plugins` |
| `assets/styles.css` | `.plg-*` по образцу `.lsp-row` |
| `assets/app.ts` | импорт `sidebarPluginsEvent` из `./js/sidebar.js` (guard `:371-390`) + слушатель SSE `plugins` |

`<button>` — ровно как остальные: `<span class="sb-ico" data-icon="plugins">` + `<span class="sb-dot">`,
иконка ставится из `ICON_NAME` в `initSidebar` (`core.ts:74-78`), разметка иконки в HTML не нужна.

### 6.2 Раскладка панели

**Не master-detail.** Сайдбар фиксирован 679px (`styles.css:810`), у Trace деталь отжаривает
340px списка — для плагинов это лишнее. Список строк + поп-ап через **существующий** `#subOverlay`
(`subdialog.ts`, `openSubDialog`), ровно как `openLspInfoDialog` (`lsp.ts:151-158`). Новых
оверлеев не заводим.

```
  Plugins                                    ⟳ reload
  ────────────────────────────────────────────────
  5 active · 1 off · 1 failed

  ◇ my-plugin          v1.2.0 · alexe        [on]
     Post-commit linter
  ◇ trace-server       v0.4.1 · mma          [on]
  – legacy-helper      v0.1.0 · alexe        [off]
  ✗ broken-plugin      failed                —
     plugin.skipped: Unexpected token '}'
```

Строка: глиф + имя + `v<ver> · author` (dim) + тумблер `makeToggle` (`dom.ts:236`). Ниже —
одна dim-строка с описанием (обрезанное до ~90 символов, полное — в попапе). Клик по строке (не по
тумблеру, `ev.stopPropagation()`, как `files.ts:158`) открывает поп-ап.

Глифы: `✓` активен, `–` выключен, `✗` не загрузился, `⚠` загрузился с предупреждениями.
Цвет — через существующие классы `.ok/.dim/.fail` (`lsp.ts:19-23`), новых цветов не вводим.

Состояние ленивое, как у LSP: `sb.plugins.loaded` + `sidebarPluginsState()` дёргает
`loadPlugins()` только при активной вкладке; при смене локали — `renderPlugins()`.

### 6.3 Поп-ап «подробности»

`openPluginDialog(record, { onToggle, onReload })` → `openSubDialog(name, box, …)`:

- **описание** — абзац; если нет — dim `web.plugins.no_description`.
- **автор / версия / источник** — строки `.kv` (`map.ts` `mapKv`).
- **homepage** — ссылка (только `http(s)`, `target=_blank rel="noopener noreferrer"`).
- **путь** — `<code>` + кнопка копирования (как `lsp.ts:196-206`).
- **что добавляет** — чипсы: тулы (`tools`), хуки (`hooks`).
- **права** — чипсы `permissions`; пусто → dim «не запрашивает». Рядом dim-строка:
  *«Права — декларация, не проверка: плагин выполняется в процессе агента»*.
- **предупреждения загрузки** — список dim-строк.
- **тумблер** — тот же `makeToggle`, что и в строке (в попапе доступен, когда строка узкая).
- **кнопка Reload** — появляется в фазе 4.
- Для упавшего плагина — вместо тумблера: причина (`error`), путь, команда «открыть папку» не
  делаем (нет FS-доступа из веба; за пользователя это делает вкладка Files).

Тонкость: тумблер внутри поп-апа и в строке — две копии одного состояния. Источник правды —
ответ сервера; оптимистичный флип разрешён только после успешного POST (контракт `makeToggle`:
`onFlip` возвращает truthy — флипаем локально, иначе перерисовываем из сервера).

### 6.4 Настройки

- `PANEL_SECTIONS.plugins` (`controls.ts:236-238`) получает секцию
  `{ id: "plugins.registry", keys: ["plugins.disabled"] }` с en+ru `titleKey`/`descKey`
  (guard-тест требует ровно одну секцию на ключ и подписи на обеих локалях).
- Плашка в панели настроек (`panels.ts:424-439`) теряет хардкод `✓` (`:426`) и получает
  `makeToggle` — тот же паттерн, что у MCP-строк (`:456-464`). Источник — `settings.pluginsData`,
  обновляемый `loadPlugins()` (`:745`).
- `web.settings.plugins_note` (`en.json:1489` / `ru.json`) **переписывается**: сегодня он велит
  «добавляй/убирай файл». Новая формулировка — про тумблер + папку + факт «код плагина
  выполняется в процессе агента».

## 7. Фазы

Каждая фаза — отдельный коммит, `bun test` + `tsc --noEmit` + `bun run quality` зелёные.
Фазы 1–3 — сам запрос; 4–6 — путь к самоавторству, каждая мержится независимо.

### Фаза 1 — Метаданные и реестр (`PluginRecord`) ✅ выполнено (`dd8e1db`)
- `modules/types.ts`: `PluginPermission`, `PluginProvides`, поля в `AgentPlugin`.
- новый `plugins/records.ts`: типы, `validatePluginMeta`, `detectHooks`, `buildRecord`.
- `manager.ts`: кэш записей, `getRecords()`, `getFailures()`, `warnings` в `RegisterResult`.
- `loader.ts`: `plugin.path`, `loadFromDir` возвращает `{loaded, skipped, failed}`, заполняет
  failures в менеджере.
- `src/index.ts`: экспорт `AgentPlugin`, `HostBridge`, `TurnSummary`, `PluginRecord` (пробел #14 —
  дешёвый и снимает duck-тинг в примерах; делаем здесь, не в фазе 5).
- CLI/REPL: общий формат вывода; `mma plugins show <name>`.
- i18n `plugin.meta_*`; `docs/plugins.md` + раздел в `docs/agents/modules.md`.
- Тесты: `tests/plugin-records.test.ts` (валидация каждого правила), дополнение
  `tests/plugin-manager.test.ts` (`getRecords`, warnings, failures), `tests/plugin-loader.test.ts`
  (path, форма возврата, разбор падения в failures).

### Фаза 2 — Включение/выключение ✅ выполнено (`dd8e1db`)
- `config/types.ts` + `defaults.ts` + `domains.ts` + `registry-extra.ts`.
- `applyPluginConfigEffects` в `registry.ts` рядом с `applyProviderModelMemory`.
- `manager.ts`: `disabled`/`active()`/`setEnabled`/`isEnabled`; все диспатчеры на `active()`.
- CLI `enable|disable`; REPL `/plugins enable|disable`; `/status` различает off.
- Решение по мёртвому `sessionIsolation.isolatePlugins`: **удалить** из
  `types/defaults/registry-extra` (наружу не выставлен, поведения не меняет) — иначе у реестра
  два конкурирующих выключателя. Отметить в `CHANGELOG` как Removed.
- Тесты: `tests/plugin-enabled.test.ts` (диспатчеры не зовут выключенный; `getAllPlugins`
  фильтрует; повторный enable идемпотентен), `tests/config-plugins.test.ts`
  (`setConfigValue("plugins.disabled", …)` → эффект; `reset`), `tests/plugin-cli.test.ts`.

### Фаза 3 — Web: REST + вкладка Plugins ✅ выполнено (`6618e0f`)
- `settings-api.ts`: расширенный `GET /api/plugins` (+`failures`), `POST /api/plugins/:name`,
  SSE `plugins`.
- `state.ts`: `WebPluginManager` на `PluginRecord`.
- фронтенд: `sidebar/plugins.ts`, правки `state/core/dom/index.html/styles/app.ts` по §6.1,
  панель настроек с тумблером, новая секция `plugins.registry`.
- i18n: `web.sidebar.tab_plugins`, `web.plugins.*`, переписанный `plugins_note`, новый
  `config.key.plugins.*`.
- Тесты: `tests/webui-plugins-api.test.ts` (GET-форма, POST-toggle, 404/400, enabled реальный),
  `tests/webui-plugins-dom.test.ts` (happy-dom: рендер списка, тумблер, поп-ап),
  обновление `tests/webui-settings.test.ts` (форма ответа), `tests/webui-assets.test.ts`
  (guard: `sidebarPluginsState(` импортирован из баррела), e2e `web-plugins`.

### Фаза 4 — Живой reload ✅ выполнено (`6b74721`)
- `AgentPlugin.onUnload?(ctx)`; `manager.ts` `unregister` + вызов `onUnload` через `safeInvoke`.
- `loader.reload()`: очистка `require.cache` для точечных entry-файлов, дифф по `path`,
  пере-регистрация, `onUnload` исчезнувших/заменённых.
- `modules-phase.ts`/`repl.ts`: `/reload` теперь чинит кэш (иначе правка кода не подхватывается
  вообще) и гасит плагины старого менеджера.
- `POST /api/plugins/reload` + кнопка в поп-апе и в шапке панели; CLI `mma plugins reload`,
  REPL `/plugins reload`.
- `SkillsModule.reload(dirs)`: мутация на месте (`load_skill` замкнул на инстанс,
  `load-skill.ts:48`), вынести резолв директорий из локалей `workspace-phase.ts:120-123`,
  пересчёт `currentTokens`/`loadedSkills`.
- **Проверка в первом же коммите:** что `delete require.cache[require.resolve(p)]` действительно
  даёт новый экспорт в Bun (иначе тактика другая — `require` на свежий путь-клон).
- Тесты: `tests/plugin-reload.test.ts` (правка файла → новый код; удаление файла → unload;
  `onUnload` вызван), `tests/skills-reload.test.ts`, обновление `tests/cli/repl-*` для `/reload`.

### Фаза 5 — Тулы от плагинов (фундамент «агент пишет себе capability») ✅ реализована
- `AgentPlugin.getToolDefinitions?(): ToolDefinition[]` (зеркалит `AgentModule.getToolDefinitions`,
  `modules/types.ts:9-14`).
- `tools/registry.ts`: `upsert(name, def)`, `unregister(name)`; `register` продолжает кидать.
- `plugins/tools.ts`: санитизация имени (переиспользовать `sanitizeToolName`,
  `mcp/module.ts:236-250`), авто-тег `plugin:<name>`, `alwaysOn` по умолчанию `true`
  (иначе `getAllForLLM` (`registry.ts:55-70`) спрячет тул под любым `enable_tools`),
  карта provenance `tool → plugin`, отказ всей вкладки при конфликте с ядром (с варнингом,
  хуки плагина остаются живы).
- Синхронизация клонов: владелец набора реестров в bootstrap, `binder.apply(реестр)` на
  главный и на все живые runner-реестры; удаление из набора при остановке раннера
  (`session-runner-scope.ts:40-51`).
- Документация: `docs/plugins.md` — раздел «Тули», предупреждение про инвалидацию prompt-prefix
  (`agent.ts:958`) и про двойную плату (schema в `body.tools` + оценка бюджета).
- Тесты: `tests/plugin-tools.test.ts` (регистрация, конфликт имён, disable снимает тул, reload
  перерегистрирует, sync в runner-клон), `tests/tools/registry-upsert.test.ts`.

### Фаза 6 — Черновики и тул `define_capability` ✅ реализована
Реализовано по плану с тремя осознанными отклонениями (все — в пользу безопасности):

1. **Каталог `.mma/plugins/drafts/`** (`plugins/drafts.ts`); `PluginRecord.draft` уже
   вычислялся из пути — union `source` не расширялся.
2. **Consent.** Отклонение: не «вопрос при первом запуске», а **инертность по умолчанию** —
   каталог без маркера `.mma/plugins/.drafts-approved` вообще не читается, а неодобренные
   черновики дают warn при старте (`plugin.drafts_pending`) и явную команду
   `mma plugins drafts approve`. Причины: в headless/one-shot вопрос некому задать, а «спросим
   при старте» в этом режиме деградирует в тихую загрузку; и **проектный** маркер честнее
   глобального конфиг-ключа (согласие на код одного воркспейса не должно разрешать его во всех).
   Маркер лежит **вне** каталога — иначе скан плагинов подхватил бы его как плагин.
   Вопрос с показом **полного кода** живёт в самом тулe (`define_capability` → `askUser` через
   `ctx.promptIO`): там он и нужен — в момент появления нового кода.
3. **Тул `define_capability(name, description, parameters, code, permissions)`** — на два
   аргумента больше, чем в плане: без JSON-схемы аргументов у тула нет контракта, а без
   `permissions` декларация пустая. Пишет черновик → показывает код → спрашивает consent →
   `draftHost.reloadDrafts()` (живая регистрация, доезжает и до открытых вкладок веба).
   `alwaysOn: true` — по той же причине, что и у тулов плагинов: блок промпта говорит модели
   про этот тул, значит он должен быть в наборе (иначе модель читает про `define_capability`
   и не видит его в схеме, а `enable_tools meta` сама не вызовется).
4. **Лимиты:** `plugins.maxDrafts` (default 10) черновиков на проект, LRU-вытеснение.
   Права обязательны на уровне валидации черновика, а не «отказ регистрации» — так дешевле и
   понятнее модели (причина сразу в её ответе).
5. **Промпт-блок `[PLUGIN CAPABILITIES]`** (`plugins/capabilities-block.ts`, подключён в
   `collectDynamicPromptBlocks`, а не в `system-prompt.ts`): перечисляет тулы плагинов и
   упоминает `define_capability`; не добавляется при сужении набора дочерним allowlist'ом.
6. **Аудит:** отдельных событий `plugin_loaded`/`draft_consent` нет — согласие и загрузка идут
   через существующие пути (`question` пишется в историю хода, загрузка черновика — через
   `PluginLoader` с обычным `plugin.loaded`). Новые события вводили бы вторую правду о том,
   что загрузилось.

## 8. Проблемы, требующие явного решения

1. **Кому принадлежит доверие.** Вся конструкция доверяет коду плагина: он выполняется в
   процессе агента с доступом к `ctx.config` (включая `provider.entries[].apiKey`), к `bash`,
   к сети. Ни disable, ни `permissions`, ни консенс в фазе 6 этого не меняют — они про
   наблюдаемость и осознанность. Настоящая изоляция (worker/`isolated-vm`/подпись+consent из
   `docs/specs/2026-09-28-production-readiness-design.md:89-100`) — отдельная работа, вне этой
   спеки. Фиксируем как явное «нет», чтобы не выдавать `permissions` за защиту.
2. **Секретные метаданные.** `homepage`/`author`/`description` попадают в UI и в
   `mma plugins list`; `path` — абсолютный путь. Ничего секретного там нет по замыслу, но при
   `--json`/логах проверить, что плагин не положил в `description` ключ от провайдера
   (`sanitizeLogMessage` это не покрывает — оно про логи, не про UI).
3. **Инвалидация prompt-prefix.** Включение/выключение плагина с тулами меняет набор тулов
   между итерациями → разрыв префикса (`agent.ts:958`) → сброс prompt-cache на следующем ходе и
   пересчёт бюджета. Приемлемо, но показываем в поп-апе dim-строку «переключение сбрасывает
   кеш промпта» (фаза 5), а не прячем.
4. **Два места, где живут «плагин-типы».** `AgentPlugin` и `PluginHook` расходятся намеренно;
   `WebPluginInfo` — мусор, удаляем в фазе 1. Плюс `WebUiState.plugins`/`WebUiDeps.plugins`
   дублируются в `module.ts:35,63` — приводим к одному импорту.
5. **Порядок при `reload`.** Новый экземпляр пере-регистрируется, старый выгружается — или наоборот?
   Выбираем «сначала новый, потом unload старого»: если новый модуль падает на импорте, старый
   продолжает работать (не теряем плагин из-за битого edit). Следствие: возможен кратковременный
   дубль (оба экземпляра в `plugins`), поэтому unload обязан идти сразу после успешного register и
   дедуп по имени это гасит.
6. **`require` в Bun и кэш.** Проверяется в фазе 4 первым коммитом; если `delete require.cache`
   не даёт эффекта, тактика — грузить через абсолютный путь с уникальным query-суффиксом в
   загрузчике (Bun это допускает) вместо опоры на инвалидацию кэша.
7. **`minMmaVersion` и выключенные плагины.** Гейт остаётся на этапе загрузки, независимо от
   `disabled` — иначе выключенный несовместимый плагин нельзя было бы включить обратно без
   правки файла.

## 9. i18n (en + ru)

Новые ключи (паритет обязателен, `tests/i18n.test.ts`):

- `plugin.meta_warning` — «{name}: {problem}» (одна на плагин, в лог и в UI).
- `cli.plugins.enabled` / `cli.plugins.disabled_state` / `cli.plugins.show` /
  `cli.plugins.enable` / `cli.plugins.disable` / `cli.plugins.reload` /
  `cli.plugins.unknown_names` / `cli.plugins.by`.
- `repl.plugins_enable` / `repl.plugins_disable` / `repl.plugins_reload` /
  `repl.plugins_off`.
- `web.sidebar.tab_plugins`.
- `web.plugins.active_summary` — «{active} active · {off} off · {failed} failed».
- `web.plugins.reload` / `web.plugins.reloading` / `web.plugins.reloaded` /
  `web.plugins.reload_failed`.
- `web.plugins.row_description` — не требуется (описание приходит с сервера).
- `web.plugins.no_description` / `web.plugins.no_path` / `web.plugins.author_unknown` /
  `web.plugins.homepage` / `web.plugins.path` / `web.plugins.provides_tools` /
  `web.plugins.provides_hooks` / `web.plugins.permissions` / `web.plugins.permissions_none` /
  `web.plugins.permissions_hint` / `web.plugins.warnings` / `web.plugins.failed_reason` /
  `web.plugins.unavailable` / `web.plugins.empty` / `web.plugins.copy_path` /
  `web.plugins.cache_note` (фаза 5).
- `config.key.plugins.disabled` + `config.enum` не нужен (тип `list`).
- `web.settings.sec.plugins.registry` (+ `.desc`) — en + ru.
- Перезапись `web.settings.plugins_note`.

## 10. Тесты

Новые файлы:

| Файл | Что покрывает |
|------|---------------|
| `tests/plugin-records.test.ts` | каждое правило валидации; `buildRecord` (все поля, включая `warnings`/`error`); `detectHooks` |
| `tests/plugin-enabled.test.ts` | `setEnabled` + все категории диспатчеров не зовут выключенный; `getAllPlugins` фильтрует; `unregister` |
| `tests/plugin-reload.test.ts` | новая запись в каталоге; правка кода; удаление файла; `onUnload`; дифф |
| `tests/plugin-tools.test.ts` | вклад тулов, конфликт имён, disable/unload снимают, sync в runner-клон |
| `tests/config-plugins.test.ts` | `plugins.disabled` через `setConfigValue` (+эффект), `reset`, `CONFIG_DOMAINS` не теряет поле |
| `tests/webui-plugins-api.test.ts` | форма `GET /api/plugins`, `POST /api/plugins/:name` (200/400/404), `enabled` настоящий, `failures` |
| `tests/webui-plugins-dom.test.ts` | рендер списка/глифов/тумблера/попапа, ленивая загрузка, redraw на toggle |
| `tests/skills-reload.test.ts` | новый навык виден без рестарта; `currentTokens` пересчитан |

Обновляемые: `tests/plugin-manager.test.ts`, `tests/plugin-loader.test.ts`,
`tests/plugin-host-bridge.test.ts`, `tests/webui-settings.test.ts`,
`tests/webui-mcp-crud.test.ts` (форма ответа), `tests/webui-assets.test.ts` (guard sidebar),
`tests/webui-sidebar-dom.test.ts` (фикстура), `tests/i18n.test.ts`, `tests/webui-boundaries.test.ts`
(если расширяются роли), e2e `tests/e2e/web-plugins.e2e-test.ts` (вкладка + тумблер + поп-ап).

Guard-тесты, которые нельзя сломать: `tests/webui-frontend-graph.test.ts` (acyclic + нет
инверсий), `tests/webui-boundaries.test.ts` (роли вместо `WebUiState`),
`tests/output/no-direct-console.test.ts` (никакого прямого вывода — только `OutputChannel`).

## 11. Вне scope (YAGNI)

- Песочница/подпись плагинов/изоляция (§8.1) — отдельная работа.
- UI-расширения от плагинов (панели в вебе, свои HTTP-роуты в `mma web`) — сейчас примеры
  поднимают свои серверы; менять это здесь не будем.
- Регистрация slash-команд плагином — нет крючка; в этой фазе не появляется.
- Авто-reload по вотчеру на каталоги плагинов (`plugins.autoReload`) — только явная команда.
- Версионирование плагинов по семверу с конфликтами/миграциями — дедуп есть, конфликтов нет.
- `onUnload` для навыков — навыки не исполняют кода, нечего выгружать.

## 12. Готовность к реализации

Фаза 1 начинается с `plugins/records.ts` — это ноль зависимостей от остального, и она
разблокирует всё остальное (включая тесты, которые сегодня невозможно написать: нельзя
проверить «плагин сломан»). Фазы 2 и 3 независимы друг от друга и могут идти параллельно
разными ветками: 2 трогает `config` + `manager`, 3 — `webui` + `assets`. Фаза 4 — самая
рискованная (проверка кэша в первом коммите), её стоит начинать только после зелёных фаз 1–3.
