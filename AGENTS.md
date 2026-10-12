# MMA — Micro Models Agent

General-purpose AI agent harness for small models (Qwen3.5-9B, 32K–64K context). Not a coding-only agent.

> **Design:** [v2 spec](./docs/specs/2025-07-28-mma-v2-design.md) · **UI canon:** [STYLE.md](./docs/design/ui/STYLE.md) · **Changelog:** [CHANGELOG.md](./CHANGELOG.md) · **Feature log:** [feature-history.md](./docs/agents/feature-history.md)

> ## ⚠️ BETA — версии только `0.x.y`
>
> `1.0.0` запрещён, пока проект в бете; автобамп в `1.x.x` запрещён. Выход из беты —
> отдельное осознанное решение (снимает запрет). Гвард: `tests/version-beta.test.ts`
> падает при version ≥ `1.0.0`.

> ## 🔴 Открытый план работ (0.3.3) — начинать с W0
>
> [Аудит](./docs/analysis/2026-10-12-harness-module-audit.md) — 125 дефектов по 9 модулям,
> не закрытых фиксами 0.3.3. [План](./docs/plans/2026-10-12-harness-module-audit-fixes.md) —
> 77 задач / 385 шагов / 11 волн. **W0 (наблюдаемость) обязательна первой**: ~15 текущих
> правок невидимы — критик, MoE-верификатор и часть гейтов пишут «ок» при поломке.
> Критический путь к исходной проблеме: `W0.1 → W1.2 → W1.3 → W4.1 → W4.4 → W4.7`.

---

## Как устроена разработка

Три команды покрывают 95% работы:

```bash
bun test              # тесты (vitest, ~3800)
bun run quality       # гейт: typecheck + typecheck:frontend + lint + fallow
bun run mma "<промпт>"   # прогнать агента вживую
```

`bun run quality` = `typecheck` + `typecheck:frontend` + `lint` + `fallow`. CI: `.gitea/workflows/quality.yml`,
`.github/workflows/quality.yml`. Pre-push hook (`.githooks/pre-push`) гоняет гейт + `bun test`
при пуше в `master`/`main`; обход — `--no-verify`.

**Перед коммитом:** `bun test` + `bun run quality` зелёные. Живой прогон — по необходимости,
`bun run mma` из **корня репо** (см. ловушку ниже).

| | |
|---|---|
| **Runtime** | Bun + TypeScript (strict, NodeNext) |
| **Тесты** | vitest через `bun test`; e2e — `bun run test:e2e` (Playwright, по явной команде) |
| **Линт** | Biome (linter only; формат — Prettier). `bun run lint` |
| **Фронтенд** | TypeScript в `src/modules/webui/assets/**`, отдельный `tsconfig.frontend.json` |
| **Зависимости** | commander, js-tiktoken, jsonrepair, picocolors, playwright, string-width, yaml |

Прочие: `bun run dev` (watch) · `bun run web:dev` (веб + live reload) · `bun run build:prod` (релиз).

**CLI:** `bun run mma setup` (мастер провайдера) · `mma meet` (знакомство) · `mma agents init` (сгенерировать AGENTS.md для workspace) · `mma session list|show|delete`.

---

## Правила работы

### Три измерения — обязательны

Изменение не завершено, пока явно проверены: **пользователь** (UX, i18n, предсказуемость,
обратимость, читаемость вывода) · **модель** (формулировки тулов, объём tool-output,
устранимость ошибок, влияние на бюджет контекста) · **смежные модули** (провайдеры, сессии,
плагины, security, контракты типов/событий/конфига, `session.jsonl`).

### Positioning: универсальный агент, не «для кода»

MMA применяют для чего угодно: разработка, погода, умный дом, API, ассистент, поиск. Промпты,
тулы и дефолты **не** предполагают задачу про репозиторий с кодом; онбординг спрашивает о профиле
и домене, а не о языке. Код (файлы, bash, LSP) — частный случай.

### Git

Любая задача — в **отдельной ветке** от `master`. В `master` не коммитим и не пушим.
Имя: `<type>/<краткое>` (`feat/`, `fix/`, `docs/`, `refactor/`, `chore/`). Спека — в той же ветке.
Интеграция — merge/PR после зелёных `bun test` + `tsc --noEmit`.

### Playwright и фоновые процессы

- **Браузер — только по явной команде пользователя.** Сам не гоняй UI-сценарии.
- **Фоновые процессы — контролируемо:** `Start-Process` фоном, логи в файл, PID сохранён,
  readiness-поллинг, остановка строго по `Stop-Process -Id`. Не убивай пачкой.
- Пишущие проверки изолируй через `MMA_CONFIG_DIR` — не пиши в реальный `~/.mma`.

### Файлы > 300 строк — не дроби без явного решения

Правило работает там, где есть чистый шов. Осознанные исключения (плотная связка с приватным
состоянием класса; дробление = риск-рефактор):

`src/core/agent.ts` (`executeSingleAgentLoop` держит состояние `Agent`) · `src/cli/repl.ts` ·
`src/ui/line-editor.ts` (DSR-протокол) · `src/modules/execution/stuck-detector.ts` ·
`src/modules/execution/module.ts` · `src/config/registry-extra.ts` и
`src/modules/webui/settings-api.ts` (плоские таблицы без shared mutable state) ·
`src/modules/webui/turns.ts` (цикл хода slots→submit→drain с per-session состоянием).

---

## Карта кода

Где что лежит — чтобы не искать. Детали — в `docs/agents/`.

| Область | Путь | Что знать перед правкой |
|---|---|---|
| Петля агента | `src/core/agent.ts`, `src/core/agent/*` | `INIT → THINK → ACT → OBSERVE → OUTPUT → ERROR` |
| Контекст/компакция | `src/modules/context/` | Бюджет: system 10% / reserve 15% / history 75% |
| Провайдеры | `src/modules/providers/` | Резолв активной **записи** из `entries[]`, не legacy-плоских полей |
| Конфиг | `src/config/registry.ts` + `registry-extra.ts` | Один путь записи — `setConfigValue` |
| Тулы | `src/tools/`, `executor.ts` | Единый исполнитель; allowlist строгий |
| Модули | `src/modules/*` | Подключаются в bootstrap-фазах (`src/core/bootstrap/`) |
| Терминал | `src/ui/`, `src/output/` | `OutputChannel` — единственный владелец терминала |
| Веб | `src/modules/webui/` | SSE + REST; состояние event-sourced |
| Сервис | `src/modules/service/` | HTTP API v1; `1 тенант = 1 процесс` |
| Плагины | `src/modules/plugins/` | Контракт экспортируется из `src/index.ts` |
| Репл/CLI | `src/cli/` | Каталог команд — `src/core/commands/` |

### Инварианты, которые легко сломать

- **Single-writer терминала.** Продюсеры эмитят `OutputEvent` в `OutputBus`. Прямой
  `console.*`/`process.*.write` в `src/` запрещён — гвард `tests/output/no-direct-console.test.ts`.
  Allowlist: crash-handler, machine JSON, browser bridge, non-TTY fallback.
- **Стиль чата — только STYLE.md.** Никаких boxed-панелей (`┌─┐`, `│─┼`); системные имена тулов
  не показываем **никогда** (только `tool.friendly.*`); один глиф действия `◇`; quiet by default.
  Расхождение со STYLE.md = баг.
- **Защищённые пути — always-on** (`protected-paths.ts`): `.git/`, `.env*`, `*.key|pem|p12|crt`,
  `.npmrc`, `.netrc` и т.д. — независимо от `security.paths.enabled`.
- **Allowlist тулов строгий.** `alwaysOn` и теги его **не** обходят. Это граница безопасности.
- **Правило #17:** подкоманды REPL/CLI и REST-маршруты — через карту хендлеров
  (`Record<string, …>`), не цепочкой `if`. Каталог команд — `src/core/commands/`.
- **Единственный источник правды:** конфиг-ключи в `registry-extra.ts`; секции веб-панели в
  `PANEL_SECTIONS`; провайдеры в `BUILTIN_PROVIDERS`; состояние веба — в SSE-событии, не в
  клиентских таймерах.
- **Типизация:** никаких `as any` (см. [code-style.md](./docs/agents/code-style.md)).

### Контекст и компакция

- `getContextTokens()` — **единственный** вход порогов компакции (калиброванная оценка).
  `getEstimatedTokens()` — сырая, только для cost/prefix/critic. Смешивать нельзя.
- Нехватка контекста лечится **сужением набора тулов** (`enable_tools`), а не усечением истории.
- `maxToolIterations` (default 200) — последняя линия; не поднимать ради одной сессии.

### Наблюдаемость — severity обязателен

- `Logger.diagnostic(...)` — внутренние диагностики. В чат попадают **только** при
  `ui.verbosity === "verbose"` (`/config ui.verbosity`).
- `logger.warn/info` — то, что пользователь обязан увидеть.
- Продюсер **никогда** не рапортует «ок», если произошёл отказ. Fail-open допустим лишь с явной
  причиной в логе — иначе поломка неотличима от успеха (именно это чинит W0 в плане).

---

## Рецепты

**Новый тул** — `src/tools/<name>.ts` → добавить в массив в `registerAllTools` (`src/tools/index.ts:93`).
В `ToolDefinition` (`src/tools/types.ts`): `tags` (для сужения набора), `alwaysOn`
(зарезервированные теги вроде `plan`/`todo`), `interactive` (спросит пользователя), `timeoutMs`
(может быть функцией от `ctx`), `boundedOutput` (для больших выводов вроде `read_file`).
Плагинный тул именуется `plugin__<плагин>__<тул>` и требует разрешения (`alwaysOn` по умолчанию).

**Ключ конфига** — деф в `src/config/registry-extra.ts` (не в `registry.ts` — он grandfathered).
Типы: `string/int/share/bool/enum/json/list`. `editor` задаёт подсказку UI, не меняя значение.
Автоматически появляется в `/config` и веб-настройках; комплитер подхватывает сам.

**Slash-команда** — каталог `src/core/commands/catalog.ts` + хендлер в `src/cli/repl-commands*.ts`
(через handler-map, правило #17). Каталог управляет `isAvailable` по поверхности.

**Событие в логе** — тип в `src/core/types.ts` + запись через `SessionLogger` (пишет в `session.jsonl`).

**Модуль** — `src/modules/<name>/`, подключается в bootstrap-фазе (`src/core/bootstrap/*-phase.ts`).

---

## Ловушки

- **Глобальный `mma` перехватывает прогоны вне репо.** Из папки без `package.json` запускается
  старый `dist/`, а не `src/` — правки «не работают». Запускай из корня репо с `-d <песочница>` и
  сверяй версию в строке `Environment: … mma <версия>` с `package.json`.
- **Действия не унифицированы между поверхностями.** Терминал печатает ANSI, веб — plain в SSE.
  Это работа адаптера `CommandOutput`; каталог команд отвечает только за «что есть».
  «Унификация вывода» — отдельная задача, не побочный эффект.
- **`disable` плагина ≠ sandbox.** Модуль уже `require`-нут, код верхнего уровня уже выполнился.
  `permissions` — декларация для показа, **не** enforcement. Настоящая изоляция — открытый вопрос
  (`docs/specs/2026-09-28-production-readiness-design.md`).
- **`vi.mock` в Bun глобален на процесс** — не использовать в тестах агента; для этого есть швы
  (`AgentDeps.runWithMoEOverride`, `orchestratorOverride`, `ToolContext.agentFactory`).
- **`gh-pages/` исключён из гейтов** намеренно (нет графа импортов; вёрстка даёт 59 ошибок линтера).
- **Три i18n-ключа есть только в `ru.json`** — `cli.config_value`, `cli.show_secrets`,
  `cli.context_size_arg`. Англоязычный help печатает их дословно. Не добавляй новые такие.

---

## Документация

| Документ | О чём |
|---|---|
| [architecture.md](./docs/agents/architecture.md) | Архитектура, Security-модуль, контракт `LLMProvider`, Host-seam, структура |
| [code-style.md](./docs/agents/code-style.md) | Форматирование, типы, async/error, именование, i18n |
| [tools.md](./docs/agents/tools.md) | Question/Browser тулы, изображения, сужение набора, процессы |
| [modules.md](./docs/agents/modules.md) | Сессии, project map, UI-рендер, плагины, бюджет контекста, стоимость |
| [execution.md](./docs/agents/execution.md) | Гарантии петли, состояния, оркестратор, MoE, галлюцинации |
| [testing.md](./docs/agents/testing.md) | Тесты из консоли, веб через Playwright, сертификация моделей |
| [service-api.md](./docs/agents/service-api.md) | `mma serve`: endpoints, envelope, конфиг, ошибки, webhook |
| [versioning.md](./docs/agents/versioning.md) | Правила версий, релизный процесс |
| [STYLE.md](./docs/design/ui/STYLE.md) | **Канон** стиля чат-вывода |
| [feature-history.md](./docs/agents/feature-history.md) | Как реализовывались фичи (вынесено из AGENTS.md 2026-10-12) |

---

## Конвенции

- **i18n:** все пользовательские строки через `t()`. Хардкод в чат/CLI = баг.
  Ключи `en`/`ru` симметричны (`tests/i18n.test.ts`).
- **События и типы** — `src/core/types.ts`.
- **Плагины:** публичный контракт (`AgentPlugin`, `HostBridge`, `TurnSummary`, `PluginRecord`,
  `PLUGIN_PERMISSIONS`) экспортируется из `src/index.ts` — внешнему плагину не нужно дублировать.

## Релиз

Версии — вехи, не счётчик PR. **PATCH** — баги, i18n, доки, тесты. **MINOR** — новые команды/тулы/
модули/ключи конфига. **MAJOR** — только реальная поломка без пути совместимости, и он **запрещён
в бете**.

Релиз: обновить `CHANGELOG.md` + `package.json` → тег `vX.Y.Z` → GitHub Actions соберёт артефакты
под 5 платформ и опубликует Release с `latest.json`.
