# MMA — Micro Models Agent

General-purpose AI agent harness for small models (Qwen3.5-9B, 32K–64K context). Не только код:
разработка, погода, умный дом, API, ассистент, поиск. Промпты, тулы и дефолты **не** предполагают
репозиторий с кодом; онбординг спрашивает о профиле и домене, а не о языке.

> **Нормативно:** [architecture v2](./docs/specs/2026-10-12-architecture-v2-design.md) ·
> **Текущее состояние:** [architecture.md](./docs/agents/architecture.md) ·
> **Гейты:** [gates.md](./docs/agents/gates.md) · **Стиль чата:** [STYLE.md](./docs/design/ui/STYLE.md) ·
> **Карта документации:** [docs/README.md](./docs/README.md) · **Changelog:** [CHANGELOG.md](./CHANGELOG.md)

> **⚠️ BETA — версии только `0.x.y`.** `1.0.0` запрещён, пока проект в бете; автобамп в `1.x.x` —
> тоже. Выход из беты — отдельное осознанное решение. Гвард: `tests/version-beta.test.ts`.

> **🔴 Архитектура в переходном состоянии.** Спека architecture v2 — целевой каркас; код
> соответствует **частично**. Инварианты `INV-N` нормативны для нового кода. Перед правкой в
> `src/core/`, `src/tools/executor.ts`, `src/modules/security/`, `src/config/` прочитай §1 спеки.

---

## Как устроена разработка

```bash
bun test                                  # вся сюита
bun test tests/core/agent.test.ts         # один файл
bun test tests/core/agent.test.ts -t "имя" # один тест
bun run quality                           # typecheck + frontend + arch-гейты + lint + fallow
bun run mma "<промпт>"                    # живой прогон агента
```

`quality` **не** заменяет `bun test`: он гоняет `tests/arch` и `tests/output` (`check:arch`), но не
всю сюиту. Что какой гейт держит — [gates.md](./docs/agents/gates.md).

CI (`.github/workflows/quality.yml`) строже локали: coverage-порог **87% funcs / 90% lines**,
`bun run evals:check`, `bun test tests/replay`, POSIX-полоса `bun run quality:posix`. pre-push на
`master`/`main` гоняет `quality && bun test`; обход — `--no-verify`, только осознанно.

Прочее: `bun run dev` (watch) · `bun run web:dev` · `bun run test:integration` ·
`bun run test:e2e` (Playwright, **только по явной команде**).

**CLI:** `bun run mma setup` · `mma meet` · `mma agents init` · `mma session list|show|delete`.

|                 |                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| **Runtime**     | Bun + TypeScript (strict, NodeNext)                                                                         |
| **Тесты**       | `bun test` — раннер Bun (vitest-совместимый API); vitest — только integration/e2e                           |
| **Линт**        | Biome (только линтер; формат — Prettier, в гейт не входит; фронтенд `assets/**` вне Biome)                  |
| **Фронтенд**    | TypeScript в `src/modules/webui/assets/**`, отдельный `tsconfig.frontend.json`                              |
| **Зависимости** | commander, fast-xml-parser, js-tiktoken, jsonrepair, pdfjs-dist, picocolors, playwright, string-width, yaml |

---

## Правила работы

По умолчанию — **минимальная правка, которая решает задачу**. Всё остальное — в реестр долгов.

### 1. Три измерения — обязательны

Изменение не завершено, пока явно проверены:
**пользователь** (UX, i18n, предсказуемость, обратимость) ·
**модель** (формулировки тулов, объём tool-output, устранимость ошибок, бюджет контекста) ·
**смежные модули** (провайдеры, сессии, плагины, security, контракты, `session.jsonl`).

### 2. Спека — только при смене контракта

Спека нужна, если меняется **публичный** контракт: API модулей (`src/core/api/`), формат
`session.jsonl` или конфига, точка enforcement, REST/SSE-событие, контракт плагина. Файл —
`docs/specs/<YYYY-MM-DD>-<тема>-design.md`, в той же ветке.

Внутренний рефакторинг, багфикс, UI-текст, новый ключ конфига по существующей схеме — **без спеки**.
Спека отвечает «что правильно», план — «в каком порядке».

### 3. Одна ветка — одна связная правка

Интеграционная ветка — **`dev`**. Задача — отдельная ветка от `dev`: `<type>/<краткое>`
(`feat/`, `fix/`, `docs/`, `refactor/`, `chore/`); в `dev` попадает слиянием, в `master` не
коммитим. Интеграция — после зелёных `bun test` + `bun run quality`.

Если правка тянет ядро **и** модуль **и** веб **и** конфиг — раздели на волны: каждая зелёная и
откатывается отдельно. Делить «по файлам» не нужно: связная правка на 4–6 файлов — норма.

### 4. Не чинить симптом, если он следствие

Перед правкой ответь: **дефект — следствие структуры или самостоятельный баг?** Признаки
«это архитектура»: повторялся на 2+ фиксах; «неправильный» код трудно объяснить; две подсистемы
решают одну задачу по-разному; отказ модуля неотличим от «модуль не нужен»; проверка живёт в
хендлере, а не в точке исполнения. Тогда нужен архитектурный шаг, а не патч.

### 5. Инвариант — это проверка, а не текст

Новое архитектурное правило сразу получает гейт: тест в `tests/arch/` (или `tests/output/`).
Правило без проверки живёт максимум до следующего большого изменения. Существующие гейты и
инварианты — [gates.md](./docs/agents/gates.md); перечень файлов там не дублируется, чтобы не гнить.

### 6. Не расширять файл «заодно»

Файл >300 строк — повод разрезать, а не «дописать». `.arch-allowlist.json` пуст; потолки только
уменьшаются. Гейт — `tests/arch/file-size.test.ts`.

### 7. Определение «готово»

Нет пункта «работает у меня». Задача закрыта, когда:

- `bun test` и `bun run quality` зелёные;
- для изменения поведения есть тест, который **падал бы** без правки;
- для UI/CLI — живой прогон;
- для текста, видимого модели или пользователю, — запись в `session.jsonl` или логе;
- для docs-only — ссылки резолвятся (`tests/docs-link-check.test.ts`).

### 8. Долг платится один раз

Костыль допустим, но не молча: запись в [debt.md](./docs/agents/debt.md) — `id`, что именно,
почему отложено, критерий выхода (обычно гейт), триггер, дата. В коде — пометка `DEBT(<id>)`;
гвард `tests/arch/debt-register.test.ts` не даёт осиротеть ни пометке, ни записи.

Пришёл триггер — долг **оплачивается** (убрать костыль или добавить проверку), а не переносится.
Реестр должен оставаться коротким: длинный список — сигнал, что задача нарезана неправильно.

### 9. Браузер и фоновые процессы

- **Playwright — только по явной команде пользователя.** Сам UI-сценарии не гоняй.
- Фоновые процессы: лог в файл, PID сохранён, readiness-поллинг, остановка строго по PID.
- Пишущие проверки изолируй через `MMA_CONFIG_DIR` — не пиши в реальный `~/.mma`.

Детали и команды — [testing.md](./docs/agents/testing.md).

### 10. CHANGELOG — только по явной команде

**`CHANGELOG.md` не обновляется без явной команды пользователя.** Правка кода,
багфикс, спека, тест или рефакторинг — не повод трогать этот файл. Запись
появляется только по прямой просьбе («добавь в changelog», «обнови changelog»,
«готовь релиз»). Без команды — ни строки.

Запись **дописывается**, а не переписывается: `bun run changelog:add Fixed "текст"`
(секции `Added|Changed|Fixed|Removed|Security|Tests`; многострочный текст — через stdin,
`echo "текст" | bun run changelog:add Fixed`). Команда вставляет пункт в
`## [Unreleased]` и сохраняет остальные байты (включая CRLF). Читать файл целиком
(~450 КБ) или переписывать его из контекста нельзя. Пункт встаёт первым в своей
секции — в файле принято «свежее сверху».

---

## Архитектура

Полное описание и нормативные инварианты — в [architecture v2](./docs/specs/2026-10-12-architecture-v2-design.md).

```
Поверхности (Host)     REPL · mma web · mma serve · one-shot
                              ▼
ЯДРО  src/core          Agent (петля+фазы) · ToolExecutor (ENFORCEMENT)
                        ContextManager · PromptAssembler · Config (registry+effects)
                        Observability (Logger/SessionLog) · ModuleHost
                        публичный API модулей: src/core/api/**
                              ▼
МОДУЛИ src/modules      lsp · browser · indexer · skills · mcp · memory · providers
                        evals · otel · documents · session(checkpoint) · service · …
```

**Критерий «ядро или модуль»:** можно ли отключить и продолжить работать? Нет → ядро. Да → модуль.
Модуль видит ядро только через `src/core/api/`.

**Зависимости.** Ядро → модули. Модуль не импортирует `core/agent/*` и не вызывает чужие
`tool.handler` напрямую. Гейт — `tests/arch/module-boundaries.test.ts` (INV-3/4).

**Enforcement — одна точка.** `ToolExecutor.execute()` — единственное место allowlist, тегов,
scope/protected-путей, SSRF и rate-limit (INV-9/10). Новый тул объявляет
`security: { caps, pathArgs?, urlArgs?, manual? }`; поле обязательное, форму стережёт
`tests/tools/security-decl.test.ts`.

**Наблюдаемость — один позвоночник.** События несут `source` (`mma` | `module:<name>` |
`tool:<name>` | `core`); ошибки — объект `module/operation/kind/cause`, не строка. Fail-open
обязан оставить запись с причиной, иначе поломка неотличима от успеха.

**Конфигурация — один путь записи.** `setConfigValue` (`src/config/registry.ts`) возвращает
**эффекты** (`context.resize`, `provider.rebuild`…), а не флаг `reconfigure: boolean`; применяет
их `applyConfigEffects`. Модуль объявляет свои ключи сам.

**Петля.** `INIT → THINK → OBSERVE → VERIFY → OUTPUT → ERROR`. Развилок нет: `Agent.run` вызывает
петлю один раз, гейты (hallucination → critic → audit) внутри. Параллельные сабагенты идут через
`ToolExecutor.fork()` в той же фазе Observe.

---

## Карта кода

| Область            | Путь                                                      | Что знать перед правкой                                       |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------------- |
| Петля агента       | `src/core/agent.ts`, `src/core/agent/*`                   | фазы, гейты, восстановление после сбоев                       |
| Контекст/компакция | `src/core/context/`                                       | `getContextTokens()` — единственный вход порогов              |
| Промпт             | `src/core/prompt-*.ts`                                    | сборка системного промпта, снимок карты на ход                |
| Провайдеры         | `src/modules/providers/`, `src/llm/`                      | активная **запись** из `entries[]`; адаптеры и пробы — `llm/` |
| Конфиг             | `src/config/`                                             | ключ — `registry*.ts`, значение — `defaults.ts`               |
| Тулы               | `src/tools/`                                              | `ToolExecutor` — единственный путь исполнения                 |
| Модули             | `src/modules/*`                                           | подключаются в bootstrap-фазах `src/core/bootstrap/`          |
| Терминал           | `src/ui/`, `src/output/`                                  | `OutputChannel` — единственный владелец терминала             |
| Веб                | `src/modules/webui/`                                      | SSE + REST; состояние event-sourced; фронтенд `assets/**`     |
| Сервис             | `src/modules/service/`                                    | HTTP API v1; 1 тенант = 1 процесс                             |
| Плагины            | `src/modules/plugins/`                                    | контракт экспортируется из `src/index.ts`                     |
| CLI/REPL           | `src/cli/`, `src/core/commands/`                          | каталог команд; подкоманды — handler-map                      |
| Тексты             | `src/i18n/*.json`, `src/modules/webui/assets/app-i18n.ts` | **два** словаря: CLI и веб                                    |
| Сборка/CI          | `scripts/`, `.github/workflows/`                          | build, release, гейты                                         |

---

## Инварианты, которые легко сломать

- **Single-writer терминала.** Продюсеры эмитят `OutputEvent` в `OutputBus`; прямой
  `console.*`/`process.*.write` в `src/` запрещён (`tests/output/no-direct-console.test.ts`).
- **Стиль чата — только STYLE.md.** Никаких boxed-панелей; системные имена тулов не показываем
  никогда (только `tool.friendly.*`); один глиф действия `◇`; quiet by default.
- **Allowlist тулов строгий.** `alwaysOn` и теги его не обходят.
- **Защищённые пути — always-on** (`src/modules/security/protected-paths.ts`): `.git/`, `.env*`,
  `*.key|pem|p12|crt`, `.npmrc`, `.netrc` — независимо от `security.paths.enabled`.
- **Подкоманды и маршруты — через handler-map** (`Record<string, …>`), не цепочкой `if`.
  Каталог команд — `src/core/commands/`.
- **Единственный источник правды:** ключ конфига — `registry*.ts` (+ значение в `defaults.ts`);
  секции веб-панели — `PANEL_SECTIONS` (`src/modules/webui/assets/js/settings/controls.ts`); провайдеры —
  `BUILTIN_PROVIDERS` (у фронтенда есть зеркало `PROVIDER_TYPES` — обновляй оба); состояние веба —
  в SSE-событии.
- **Типизация:** никаких `as any` ([code-style.md](./docs/agents/code-style.md)).
- **i18n:** пользовательские строки — через `t()`; ключи `en`/`ru` симметричны (`tests/i18n.test.ts`);
  строки веба — в `app-i18n.ts` (`tests/webui-i18n.test.ts`).
- **Сгенерированное не редактируем:** `dist/`, `gh-pages/`, `certification/`, `tmp/`, `*.log`.

---

## Рецепты

**Новый тул** — `src/tools/<name>.ts` → массив в `registerAllTools` (`src/tools/index.ts`).
В `ToolDefinition`: `tags`, `alwaysOn`, `interactive`, `timeoutMs`, `boundedOutput` и обязательный
`security: { caps, pathArgs?, urlArgs?, manual? }`.

**Ключ конфига** — определение в `src/config/registry-extra.ts`, **значение в `src/config/defaults.ts`**
(иначе падает `tests/arch/default-single-source.test.ts`). Типы: `string/int/share/bool/enum/json/list`.

**Slash-команда** — каталог `src/core/commands/catalog.ts` + хендлер в `src/cli/repl-commands*.ts`
через handler-map.

**Событие в логе** — тип в `src/core/types.ts` + запись через `SessionLogger` + `module` (INV-13).

**Модуль** — `src/modules/<name>/`, подключение в bootstrap-фазе. Новый модуль требует решения:
`critical?` и `teardown?` (§3.3 спеки).

---

## Ловушки

- **Глобальный `mma` перехватывает прогоны вне репо.** Из папки без `package.json` запускается
  старый `dist/`, а не `src/`. Запускай из корня с `-d <песочница>` и сверяй `mma <версия>` в
  строке `Environment: …` с `package.json`.
- **`tests/integration/**` исключён из `bun test`** (`bunfig.toml`). Тест, положенный туда, молча
  не запустится — либо клади в `tests/`, либо гоняй `bun run test:integration`.
- **`CHANGELOG.md` — 450 КБ.** Не читай целиком; новая запись — `bun run changelog:add`,
  свежее сверху.
- **`disable` плагина ≠ sandbox.** Модуль уже `require`-нут; `permissions` — декларация для показа,
  не enforcement.
- **`vi.mock` в Bun глобален на процесс** — не использовать в тестах агента; есть швы
  (`ToolContext.agentFactory`, `criticOverride`, `finalAudit`).
- **`gh-pages/` исключён из гейтов** намеренно (нет графа импортов).

---

## Документация

| Документ                                                                         | О чём                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [docs/README.md](./docs/README.md)                                               | карта документации: что нормативно, где история               |
| [CONTRIBUTING.md](./CONTRIBUTING.md)                                             | клонирование, ветки, PR, DoD                                  |
| [architecture v2](./docs/specs/2026-10-12-architecture-v2-design.md)             | целевая архитектура, INV-1…23                                 |
| [architecture v2 — схемы](./docs/specs/2026-10-12-architecture-v2-schematics.md) | boot/ход/enforcement/конфиг                                   |
| [architecture.md](./docs/agents/architecture.md)                                 | текущее состояние: Output, Host-seam, Security, `LLMProvider` |
| [gates.md](./docs/agents/gates.md)                                               | инвариант → гейт, CI-гейты                                    |
| [debt.md](./docs/agents/debt.md)                                                 | реестр долгов (pay-once)                                      |
| [testing.md](./docs/agents/testing.md)                                           | живые прогоны, Playwright, сертификация                       |
| [code-style.md](./docs/agents/code-style.md)                                     | форматирование, типы, async/error, i18n                       |
| [STYLE.md](./docs/design/ui/STYLE.md)                                            | канон стиля чат-вывода                                        |

Остальное: [execution](./docs/agents/execution.md) · [tools](./docs/agents/tools.md) ·
[modules](./docs/agents/modules.md) · [service-api](./docs/agents/service-api.md) ·
[versioning](./docs/agents/versioning.md) · [observability](./docs/agents/observability.md) ·
[ModuleHost](./docs/specs/2026-10-13-w1-module-host-design.md) ·
[enforcement](./docs/specs/2026-10-13-w2-enforcement-design.md) ·
[reasoning](./docs/specs/2026-10-15-reasoning-strategy-design.md) ·
[handoff](./docs/plans/2026-10-12-architecture-v2-handoff.md).

---

## Релиз

Версии — вехи, не счётчик PR. **PATCH** — баги, i18n, доки, тесты. **MINOR** — новые
команды/тулы/модули/ключи конфига. **MAJOR** — только реальная поломка без пути совместимости, и он
**запрещён в бете**.

Релиз: `CHANGELOG.md` + `package.json` → тег `vX.Y.Z` → GitHub Actions собирает артефакты под 5
платформ и публикует Release с `latest.json`. npm publish не используется. Релизный коммит и тег —
на `master`, перед этим `dev` сливается в `master` обычным merge. Единственный remote — `origin`
(GitHub); зеркал нет.
