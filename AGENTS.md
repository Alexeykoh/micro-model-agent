# MMA — Micro Models Agent

General-purpose AI agent harness for small models (Qwen3.5-9B, 32K–64K context). Не только код.

> **Архитектура (нормативно):** [architecture v2](./docs/specs/2026-10-12-architecture-v2-design.md)
> · **Описание текущего состояния:** [architecture.md](./docs/agents/architecture.md)
> · **Канон стиля чата:** [STYLE.md](./docs/design/ui/STYLE.md)
> · **Changelog:** [CHANGELOG.md](./CHANGELOG.md) · **Лог фич:** [feature-history.md](./docs/agents/feature-history.md)

> ## ⚠️ BETA — версии только `0.x.y`
>
> `1.0.0` запрещён, пока проект в бете; автобамп в `1.x.x` запрещён. Выход из беты —
> отдельное осознанное решение. Гвард: `tests/version-beta.test.ts` падает при version ≥ `1.0.0`.

> ## 🔴 Архитектура в переходном состоянии
>
> Спека **architecture v2** описывает целевой каркас; код ему соответствует **частично**.
> Инварианты из спеки помечены `INV-N` — они нормативны для нового кода. Перед правкой
> в `src/core/`, `src/tools/executor.ts`, `src/modules/security/`, `src/config/` прочитай
> §1 спеки. Разбор текущего состояния и 13 находок, которых не было в аудите, — там же.

---

## Позиционирование

MMA применяют для чего угодно: разработка, погода, умный дом, API, ассистент, поиск.
Промпты, тулы и дефолты **не** предполагают задачу про репозиторий с кодом; онбординг
спрашивает о профиле и домене, а не о языке. Код (файлы, bash, LSP) — частный случай.

---

## Как устроена разработка

```bash
bun test              # тесты (vitest, ~3800)
bun run quality       # гейт: typecheck + typecheck:frontend + lint + fallow
bun run mma "<промпт>"   # прогнать агента вживую
```

Инварианты §1 спеки под гвардами (`tests/arch/*`, `tests/output/*`,
`tests/tools/security-decl.test.ts`); они прогоняются в `bun run quality` шагом
`check:arch` (`bun test tests/arch tests/output`). Правило «≤300 строк» — гейт
`tests/arch/file-size.test.ts` + `.arch-allowlist.json` (потолки только уменьшаются).
[docs/agents/debt.md](./docs/agents/debt.md) (правило 9).

Прочие: `bun run dev` (watch) · `bun run web:dev` · `bun run build:prod` (релиз) ·
`bun run test:e2e` (Playwright, **только по явной команде**).

**CLI:** `bun run mma setup` (мастер провайдера) · `mma meet` · `mma agents init` ·
`mma session list|show|delete`.

| | |
|---|---|
| **Runtime** | Bun + TypeScript (strict, NodeNext) |
| **Тесты** | vitest через `bun test` |
| **Линт** | Biome (linter only; формат — Prettier) |
| **Фронтенд** | TypeScript в `src/modules/webui/assets/**`, отдельный `tsconfig.frontend.json` |
| **Зависимости** | commander, js-tiktoken, jsonrepair, picocolors, playwright, string-width, yaml |

---

## Правила работы

### 1. Три измерения — обязательны

Изменение не завершено, пока явно проверены:
**пользователь** (UX, i18n, предсказуемость, обратимость, читаемость) ·
**модель** (формулировки тулов, объём tool-output, устранимость ошибок, бюджет контекста) ·
**смежные модули** (провайдеры, сессии, плагины, security, контракты типов/событий/конфига,
`session.jsonl`).

### 2. Спека — до кода, если меняется система

Правка, которая меняет **контракт** (путь данных, границу модуля, точку enforcement,
формат события, схему конфига), сначала получает спеку в
`docs/specs/<YYYY-MM-DD>-<тема>-design.md`. Правка в пределах существующего контракта —
спеки не требует.

Спека отвечает на «что правильно», план — на «в каком порядке». Не смешивать.

### 3. Одна задача — одна ветка, один контракт

Любая задача — **отдельная ветка** от `master`: `<type>/<краткое>`
(`feat/`, `fix/`, `docs/`, `refactor/`, `chore/`). В `master` не коммитим и не пушим.
Спека коммитится в той же ветке. Интеграция — merge/PR после зелёных `bun test` + `bun run quality`.

**Задача, которая правит 6 файлов, — это 6 задач.** Если правка затрагивает и ядро, и модуль,
и веб, и конфиг — раздели на волны, у каждой проверяемый результат. Массовая правка
«заодно» в рамках одной ветки недопустима: её невозможно откатить частично и невозможно
ревьюить.

### 4. Не чинить симптом, если он следствие

Перед правкой ответь на вопрос: **этот дефект — следствие структуры или самостоятельный баг?**
Ответ «следствие» означает: либо фикс не поможет и вернётся, либо нужен архитектурный шаг
(см. спеку architecture v2), а не патч. Признаки «это архитектура»:

- дефект повторялся на 2+ фиксах в этой подсистеме;
- «неправильный» код трудно объяснить — значит, неверна граница, а не автор;
- две подсистемы решают одну задачу по-разному (сборка промпта в трёх местах);
- отказ модуля неотличим от «модуль не нужен»;
- проверка живёт в хендлере, а не в точке исполнения.

### 5. Инвариант — это проверка, а не текст

Если правило можно нарушить незаметно — оно будет нарушено. Любое новое правило
архитектуры сразу получает проверку: тест или guard (гейты — `tests/arch/*`,
`tests/output/*`, прогоняются в `quality` шагом `check:arch`).
Правило без проверки живёт максимум до следующего большого изменения.

Сейчас проверками являются: `tests/output/no-direct-console.test.ts`,
`tests/webui-boundaries.test.ts`, `tests/webui-frontend-graph.test.ts`,
`tests/core/command-catalog.test.ts`, `tests/version-beta.test.ts`,
`tests/no-moe-surface.test.ts`, `tests/output/source-filled.test.ts`,
`tests/arch/module-boundaries.test.ts`, `tests/tools/security-decl.test.ts`,
`tests/arch/debt-register.test.ts`, `tests/arch/outbound-policy.test.ts`,
`tests/core/session-diagnose.test.ts`, `tests/arch/observability-coverage.test.ts`,
`tests/arch/double-honesty.test.ts`, `tests/replay/invariants.test.ts`, `tests/arch/guidance-enforcement.test.ts`.

### 6. Не расширять файл «заодно»

Правило ≤300 строк действует там, где есть чистый шов. Файлы >300 строк —
в `.arch-allowlist.json` с причиной и датой. Снятие из списка — отдельная задача
(см. W5 спеки architecture v2 для `agent.ts`).

Осознанные исключения сейчас: `src/core/agent.ts` (разбор в W5) · `src/cli/repl.ts` ·
`src/ui/line-editor.ts` (DSR-протокол) · `src/modules/execution/stuck-detector.ts` ·
`src/modules/execution/module.ts` · `src/config/registry-extra.ts` и
`src/modules/webui/settings-api.ts` (плоские таблицы) · `src/modules/webui/turns.ts`
(цикл хода с per-session состоянием).

### 7. Определение «готово»

Пункта «работает у меня» нет. Задача закрыта, когда:
`bun test` зелёный · `bun run quality` зелёный · для изменения поведения — тест, который
**падал бы** без правки · для UI/CLI — живой прогон · для текста, видимого модели или
пользователю, — запись в `session.jsonl` или логе, по которой видно, что произошло.

### 8. Playwright и фоновые процессы

- **Браузер — только по явной команде пользователя.** Сам не гоняй UI-сценарии.
- **Фоновые процессы — контролируемо:** `Start-Process` фоном, логи в файл, PID сохранён,
  readiness-поллинг, остановка строго по `Stop-Process -Id`. Не убивай пачкой.
- Пишущие проверки изолируй через `MMA_CONFIG_DIR` — не пиши в реальный `~/.mma`.

### 9. Долг платится один раз (pay-once)

Костыль, временное решение, отложенная правка — **допустимы**, но не **молча**. Долг,
которого нет в реестре ([`docs/agents/debt.md`](./docs/agents/debt.md)), не существует:
«оставим на потом» без записи — дефект процесса, а не экономия.

Каждая запись: `id` · что именно · **почему** отложено · **критерий выхода** (что значит
«заплачено» — обычно проверка из правила 5) · **триггер** (какая задача/волна платит) · дата.

- **Отложить можно один раз.** Когда названный триггер трогает этот код или волна
  наступила — долг **оплачивается**, а не переносится. Повторный перенос — нарушение;
  требует явного решения пользователя и причины в реестре.
- **Заплатить = убрать костыль или добавить проверку.** Для изменения поведения —
  тест, который падал бы до правки (правило 7).
- В месте кода/спеки долг помечен `DEBT(<id>)`; гвард `tests/arch/debt-register.test.ts`
  не даёт осиротеть ни пометке, ни записи.
- Реестр должен оставаться **коротким**. Растущий реестр — сигнал, что задача нарезана
  неправильно (правило 3), а не что «долг нормален».

---

## Архитектура

Полное описание и нормативные инварианты — в
[architecture v2](./docs/specs/2026-10-12-architecture-v2-design.md). Здесь — карта.

### Слои

```
Поверхности (Host)     REPL · mma web · mma serve · one-shot
                              ▼
ЯДРО  src/core          Agent (петля+фазы) · ToolExecutor (ENFORCEMENT)
                        ContextManager · PromptAssembler · ConfigStore
                        Observability (Logger/SessionLog) · ModuleHost
                        публичный API модулей: src/core/api/**
                              ▼
МОДУЛИ src/modules      lsp · browser · indexer · skills · mcp · memory
                        critic(service) · execution(plan) · onboarding · service · …
```

**Критерий «ядро или модуль»:** можно ли отключить и продолжить работать?
Нет → ядро. Да → модуль. Границы, проведённые не по этому критерию, — источник
половины дефектов аудита.

`context/` и `hallucination/` переехали в **ядро** (`src/core/context/`,
`src/core/hallucination/`, W4). В **модулях** остаётся всё отключаемое; модуль видит
ядро только через `src/core/api/`.

### Направление зависимостей

Ядро → модули. **Модуль не импортирует `core/agent/*` и не вызывает чужие `tool.handler`
напрямую.** Держит гвард `tests/arch/module-boundaries.test.ts` (INV-3/INV-4): текущие
зависимости — явный allowlist, который может только сокращаться.

### Enforcement — одна точка

`ToolExecutor.execute()` — единственное место, где применяются allowlist, теги,
scope/protected-пути, SSRF, rate-limit (W2, INV-9/10). Хендлер тула политику **не**
реализует и не импортирует security-примитивы. Новый тул объявляет
`security: { caps, pathArgs?, urlArgs?, manual? }` — поле обязательное (без него не
компилируется); форму стережёт `tests/tools/security-decl.test.ts`, применение —
`tests/tools/enforcement-*.test.ts`.

### Наблюдаемость — один позвоночник

Все события несут `source` (`mma` | `module:<name>` | `tool:<name>` | `core`).
Все ошибки — объект с `module/operation/kind/cause`, не строка. Fail-open обязан оставить
запись с причиной, иначе поломка неотличима от успеха.

### Конфигурация — один путь записи

`ConfigStore.set` возвращает **эффекты** (`context.resize`, `provider.rebuild`…), а не
флаг `reconfigure: boolean`. Модуль объявляет свои ключи сам.

### Петля

```
INIT → THINK → OBSERVE → VERIFY → OUTPUT → ERROR
```
Развилки нет: `Agent.run` вызывает петлю ровно один раз, все гейты (hallucination →
critic → audit) стоят внутри. MoE удалён 2026-10-12 — он был вторым путём исполнения
и обходил гейты ([спека](./docs/specs/2026-10-12-remove-moe-design.md)).
Параллельные сабагенты — не развилка: `parallelizable` на `subagent` гонит их через
`ToolExecutor.fork()` в той же фазе Observe.

---

## Карта кода

| Область | Путь | Что знать перед правкой |
|---|---|---|
| Петля агента | `src/core/agent.ts`, `src/core/agent/*` | разбор на фазы — W5 спеки |
| Контекст/компакция | `src/core/context/` (переехал из `modules/`, W4) | `getContextTokens()` — единственный вход порогов |
| Провайдеры | `src/modules/providers/` | резолв активной **записи** из `entries[]`, не legacy-полей |
| Конфиг | `src/config/registry.ts` + `registry-extra.ts` | `registry.ts` grandfathered; новые дефы — в `-extra` |
| Тулы | `src/tools/` | `ToolExecutor` — единственный путь исполнения |
| Модули | `src/modules/*` | подключаются в bootstrap-фазах `src/core/bootstrap/` |
| Терминал | `src/ui/`, `src/output/` | `OutputChannel` — единственный владелец терминала |
| Веб | `src/modules/webui/` | SSE + REST; состояние event-sourced |
| Сервис | `src/modules/service/` | HTTP API v1; `1 тенант = 1 процесс` |
| Плагины | `src/modules/plugins/` | контракт экспортируется из `src/index.ts` |
| Репл/CLI | `src/cli/` | каталог команд — `src/core/commands/` |

---

## Инварианты, которые легко сломать

- **Single-writer терминала.** Продюсеры эмитят `OutputEvent` в `OutputBus`. Прямой
  `console.*`/`process.*.write` в `src/` запрещён — гвард `tests/output/no-direct-console.test.ts`.
  Allowlist: crash-handler, machine JSON, browser bridge, non-TTY fallback.
- **Стиль чата — только STYLE.md.** Никаких boxed-панелей (`┌─┐`, `│─┼`); системные имена
  тулов не показываем **никогда** (только `tool.friendly.*`); один глиф действия `◇`;
  quiet by default. Расхождение со STYLE.md = баг.
- **Allowlist тулов строгий.** `alwaysOn` и теги его **не** обходят.
- **Защищённые пути — always-on** (`protected-paths.ts`): `.git/`, `.env*`, `*.key|pem|p12|crt`,
  `.npmrc`, `.netrc` — независимо от `security.paths.enabled`.
- **Правило #17:** подкоманды REPL/CLI и REST-маршруты — через карту хендлеров
  (`Record<string, …>`), не цепочкой `if`. Каталог команд — `src/core/commands/`.
- **Единственный источник правды:** конфиг-ключи в `registry-extra.ts`; секции веб-панели в
  `PANEL_SECTIONS`; провайдеры в `BUILTIN_PROVIDERS`; состояние веба — в SSE-событии.
- **Типизация:** никаких `as any` (см. [code-style.md](./docs/agents/code-style.md)).
- **i18n:** все пользовательские строки через `t()`. Хардкод в чат/CLI = баг.
  Ключи `en`/`ru` симметричны (`tests/i18n.test.ts`).

---

## Рецепты

**Новый тул** — `src/tools/<name>.ts` → добавить в массив `registerAllTools`
(`src/tools/index.ts:93`). В `ToolDefinition`: `tags` (сужение набора), `alwaysOn`,
`interactive`, `timeoutMs`, `boundedOutput`, **`security: { caps, pathArgs?, urlArgs?,
manual? }`** (INV-9/10; поле обязательно — enforcement в `ToolExecutor.execute()`).

**Ключ конфига** — деф в `src/config/registry-extra.ts`. Типы:
`string/int/share/bool/enum/json/list`. `editor` задаёт подсказку UI, не меняя значение.

**Slash-команда** — каталог `src/core/commands/catalog.ts` + хендлер в
`src/cli/repl-commands*.ts` (через handler-map, правило #17).

**Событие в логе** — тип в `src/core/types.ts` + запись через `SessionLogger` +
указать `module` (INV-13).

**Модуль** — `src/modules/<name>/`, подключается в bootstrap-фазе. Появление нового
модуля требует решения: `critical?` и `teardown?` (§3.3 спеки).

---

## Ловушки

- **Глобальный `mma` перехватывает прогоны вне репо.** Из папки без `package.json`
  запускается старый `dist/`, а не `src/`. Запускай из корня репо с `-d <песочница>` и
  сверяй версию в строке `Environment: … mma <версия>` с `package.json`.
- **`disable` плагина ≠ sandbox.** Модуль уже `require`-нут, код верхнего уровня уже
  выполнился. `permissions` — декларация для показа, **не** enforcement.
- **`vi.mock` в Bun глобален на процесс** — не использовать в тестах агента; есть швы
  (`ToolContext.agentFactory`, `criticOverride`, `finalAudit`).
- **`gh-pages/` исключён из гейтов** намеренно (нет графа импортов; вёрстка даёт 59 ошибок).
- **Три i18n-ключа есть только в `ru.json`** — `cli.config_value`, `cli.show_secrets`,
  `cli.context_size_arg`. Не добавляй новые такие.

---

## Документация

| Документ | О чём |
|---|---|
| [architecture v2](./docs/specs/2026-10-12-architecture-v2-design.md) | **Целевая архитектура, инварианты INV-1…23, план миграции** |
| [architecture v2 — схемы](./docs/specs/2026-10-12-architecture-v2-schematics.md) | Схемы boot/ход/enforcement/наблюдаемость/конфиг + матрица контрактов |
| [remove-moe](./docs/specs/2026-10-12-remove-moe-design.md) | Удаление MoE: что снято, что осталось, порядок шагов |
| [handoff](./docs/plans/2026-10-12-architecture-v2-handoff.md) | **Точка входа для следующей сессии**: статус W0–W2, порядок волн, открытые решения |
| [debt.md](./docs/agents/debt.md) | **Реестр долгов (pay-once)**: что отложено, критерий выхода, триггер (правило 9) |
| [observability.md](./docs/agents/observability.md) | Инвентарь fail-open путей и их сигналов (INV-15) |
| [w1-module-host](./docs/specs/2026-10-13-w1-module-host-design.md) | Контракт `ModuleHost`, миграция модулей, гейт (INV-2/5/7/8/16) |
| [w2-enforcement](./docs/specs/2026-10-13-w2-enforcement-design.md) | Единая точка enforcement, `ToolSecurityDecl` (INV-9/10) |
| [architecture.md](./docs/agents/architecture.md) | Текущее состояние: Output, Host-seam, Security, контракт `LLMProvider` |
| [code-style.md](./docs/agents/code-style.md) | Форматирование, типы, async/error, именование, i18n |
| [tools.md](./docs/agents/tools.md) | Question/Browser, изображения, сужение набора, процессы |
| [modules.md](./docs/agents/modules.md) | Сессии, project map, UI-рендер, плагины, бюджет, стоимость |
| [execution.md](./docs/agents/execution.md) | Гарантии петли, состояния, оркестратор, MoE, галлюцинации |
| [testing.md](./docs/agents/testing.md) | Тесты из консоли, веб через Playwright, сертификация моделей |
| [service-api.md](./docs/agents/service-api.md) | `mma serve`: endpoints, envelope, конфиг, ошибки, webhook |
| [versioning.md](./docs/agents/versioning.md) | Правила версий, релизный процесс |
| [STYLE.md](./docs/design/ui/STYLE.md) | **Канон** стиля чат-вывода |
| [feature-history.md](./docs/agents/feature-history.md) | Как реализовывались фичи (вынесено из AGENTS.md 2026-10-12) |

---

## Релиз

Версии — вехи, не счётчик PR. **PATCH** — баги, i18n, доки, тесты. **MINOR** — новые
команды/тулы/модули/ключи конфига. **MAJOR** — только реальная поломка без пути
совместимости, и он **запрещён в бете**.

Релиз: обновить `CHANGELOG.md` + `package.json` → тег `vX.Y.Z` → GitHub Actions соберёт
артефакты под 5 платформ и опубликует Release с `latest.json`.