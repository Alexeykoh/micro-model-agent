# Handoff: переход на Architecture v2

**Дата:** 2026-10-13 · **Ветка:** `docs/architecture-v2` · **База:** `master` (`65ba2f68`)
**Состояние:** `bun test` 3782 pass / 0 fail · `bun run quality` exit 0 · **18 коммитов не запушены**

Документ для следующей сессии: что сделано, где остановились, что делать дальше.
Открытые долги — единым реестром в [debt.md](../agents/debt.md) (правило 9).
Правила работы — в [AGENTS.md](../../AGENTS.md) (9 пунктов).

---

## 1. Что сделано в этой сессии

| # | Коммит | Что |
|---|---|---|
| 1 | `160a7f67` | Спека **architecture v2** + переписан AGENTS.md (~1900 → ~230 строк) + правила работы |
| 2 | `6d848277` | Схемы v2: полная схема, boot, фазы хода, enforcement, наблюдаемость, конфиг, матрица контрактов |
| 3 | `18691c0a` | Синхронизация спек с удалением MoE (чеклист задач сохранён) |
| 4 | `c3bc9d3e` | **Удаление MoE** — один путь выполнения |
| 5 | `chore/moe-closeout` | Зачистка остатков поверхности MoE (dead-поле/тип/cert/CSS/фикстуры, призрачные комментарии по `src/`) + гвард `tests/no-moe-surface.test.ts` (правило 5) |

Плюс перенесены из ветки `docs/harness-module-audit`: аудит модулей, план фиксов,
feature-history (вынесен из AGENTS.md).

### Документы

| Документ | Что в нём |
|---|---|
| [architecture-v2-design](../specs/2026-10-12-architecture-v2-design.md) | **Нормативная спека**: 23 инварианта (INV-1…23), целевой каркас, 6 волн миграции, гейты |
| [architecture-v2-schematics](../specs/2026-10-12-architecture-v2-schematics.md) | Mermaid-схемы + матрица контрактов + запрещённые связки |
| [remove-moe-design](../specs/2026-10-12-remove-moe-design.md) | Что снято, что осталось, чеклист из 9 шагов (все ✅) |
| [harness-module-audit](../analysis/2026-10-12-harness-module-audit.md) | ~90 подтверждённых дефектов по 9 модулям |
| [harness-module-audit-fixes](../plans/2026-10-12-harness-module-audit-fixes.md) | План фиксов, 11 волн / 77 задач |

---

## 2. MoE удалён: что именно изменилось

**Удалено** (`c3bc9d3e`): 7 файлов рантайма (`agent-moe` 531, `moe-executor` 620,
`orchestrator` 402, `plan-validator` 254, `input-from` 85, `expert-model-check` 92,
`moe-parallelism` 66 строк), + `execution/types.ts` и `llm/types.ts`;
ветка MoE в `Agent.run`; `AgentDeps.runWithMoEOverride`/`onMoEState`;
`AgentResult.moeHandled`; ключи `moe.*` и `orchestrator.*`; события `moe_*`;
веб-чип, `moeActive`, `moeSessions`, секция настроек, строки trace;
экспорты `OrchestratorClient`/`OrchestratorConfig`; ключи i18n; 16 тестовых файлов.

**Осталось и работает в одиночном пути:**

- `parallelizable: true` на `subagent` + `ToolExecutor.fork()` — параллельные
  сабагенты идут через тот же `enforcement`;
- `config.experts` + `resolveExpertProvider` + `subagent { expert_tag }` —
  пер-экспертная модель/провайдер/теги;
- `StepVerifier.verifyStep` и machine-readable проверки — переanchored с
  MoE-подзадач на шаг плана через `verifyCriteria(owner)`;
- `plan` / `plan_step` / `todo` / `verify`.

**Совместимость:** старые `moe.*`/`orchestrator.*` в `config.json` игнорируются
при загрузке (неизвестные ключи); старые `moe_*` записи в `session.jsonl` парсятся.

**Проверено живьём (2026-10-12):** прогон на `qwen/qwen3.5-9b` (LM Studio,
изолированный `MMA_CONFIG_DIR`, `mma "<prompt>" -d <sandbox> -e --json`).
Модель выдала **два `subagent`-вызова в одном батче** (iteration 2) — параллелизм
идёт через одиночный путь, как раньше через MoE-волны. В `session.jsonl`:
`plan` + `plan_step` ×3, `critic_check`, `claim_retry` (галлюцинация поймала
ложную «успех»-заявку после блокировки `bash`), `tool_result` сабагентов;
событий `moe_*` — ноль. Enforcement сработал: `bash` с `;` заблокирован.
Старые `moe.enabled`/`orchestrator` в конфиге загрузились **без предупреждений**
(`warnings: {}`), как и обещает §4. Abort end-to-end не гоняли (one-shot без Esc),
но покрыт юнит-тестами одиночного пути (`agent-turn-end.test.ts`,
`agent.test.ts` «interrupt between batch tools»).

---

## 3. Где остановились: следующий шаг — **W0 (наблюдаемость)**

Спека стоит на дисциплине до W1. W0 —
самая дешёвая волна и делает дальнейший разбор автоматизируемым.

**W0.1 сделана** (`feat/w0-output-source`): введён `Source` (`output/types.ts`),
эмиттеры заполняют его — `Logger` → `module:<prefix>`/`mma`, `channel.writeLine`
и прямые `defaultOutputBus.log` → `module:<name>`/`tool:<name>`/`mma`. Терминал
показывает короткую метку (`module:indexer` → `[indexer]`), машинные стоки видят
канонический `Source`. Гвард `tests/output/source-filled.test.ts`.

**W0.4 сделана** (`feat/w0-diagnostic-log-error`): `logError(diag: Diagnostic)`
вместо строки. `Diagnostic` — дискриминированный союз (`cause` обязателен при
`kind !== "ok"`, INV-12) с `source`/`operation`/`kind`/`recoverable`. Пишется в
`session.jsonl` полями `source`/`operation`/`errorKind`/`cause`/`recoverable`
(`content` = причина, старые читатели Trace работают); whitelist `log-api`
расширен `operation`/`errorKind`/`recoverable`. 3 вызова в `agent.ts` переведены.

**W0.3 сделана** (`feat/w0-session-module`): `SessionLogEntry.module` + шаблон
`module_${string}` в `type`. Поле заполняется из `Source` (`moduleOf`) при
персистентности output-событий (`session-sink`) — т.е. `mcp`/`audit`/`security`
записи получают владельца. Whitelist `log-api` расширен `module`.

**W0.6 (частично)** (`feat/w0-failopen-signals`): cherry-pick `82968f96` из
`docs/harness-module-audit` (наблюдаемость деградации критика: `critic_degraded`,
`critic.maxTokens`/`critic.timeoutMs`, `critic_verdict {degraded:true}`) + INV-15:
`SessionLogger.logDiagnosticEvent(type, diag)` пишет `critic_error` (CriticGate,
при отказе вердикта, с причиной) и `tool_attempt` (tool-batch, хендлер бросил).
Инвентарь fail-open путей — `docs/agents/observability.md`. **`verify_error`**
сделан отдельным шагом (2026-10-13, ниже): `StepVerifier.onDegrade` →
`ExecutionModule.setDiagnosticSink` → запись в сессию (без расширения `ToolContext`).

**Следующий шаг:** W0.5 (`PromptBlock.source` + `degraded`, INV-1/6/17). W0.2 — в W1 (`ModuleHost`).

**W0.5 сделана** (`feat/w0-prompt-block-owner`): `PromptBlock.source` (владелец)
+ `label` (имя блока) + `degraded?: { reason }` (INV-1/6/17). `ModuleRegistry`
штампует `source = имя модуля`; core/static-блоки получают владельца на месте
(`core`, `agents-md`, `plugin`, `plugins`). `PromptBuilder` строит метку как
`владелец: имя` (`indexer: project map`), а не обрезанную первую строку контента;
выпавший по бюджету блок несёт `reason: "budget: N tok did not fit"`. Стартовый
overflow-warning называет владельца и блок, а не только класс по `kind`.

**W0 закрыт:** `verify_error` (2026-10-13) и `W0.2` (`Logger.child()` из `ModuleHost.ctx`).

| Задача | Что сделать | Инвариант |
|---|---|---|
| **W0.1** ✅ | `Source = mma \| module:<name> \| tool:<name> \| core` → заполнять `OutputEvent.source` (сейчас **всегда `""`**, `output/channel.ts`) | INV-13 |
| **W0.2** | `Logger.child()` включать в модулях (сейчас **0 вызовов** по всему `src/`) | INV-13 |
| **W0.3** ✅ | `SessionLogEntry.module: string` + шаблон `module_${string}` (по образцу `onboarding_${string}`) | INV-13 |
| **W0.4** ✅ | `logError(message)` → `logError(Diagnostic { source, operation, kind, cause? })`; `cause` обязателен при `kind !== "ok"` | INV-12, INV-14 |
| **W0.5** ✅ | `PromptBlock.source` + `degraded?: { reason }`; при выпадении по бюджету лог говорит «indexer: project map (2400 ток.) не поместился», а не обрезанный текст | INV-1, INV-6, INV-17 |
| **W0.6** ✅ | Отдельные события для fail-open путей: `critic_error` ✅, `tool_attempt` ✅, `verify_error` ✅ (2026-10-13) | INV-12, INV-15 |

**Стартовые точки для чтения:** `src/output/types.ts` (`OutputEvent`),
`src/output/channel.ts` (единственный emit с `source: ""`),
`src/logger/app-logger.ts` (`child`), `src/core/session-logger.ts` (`logError`),
`src/modules/session/store.ts` (`SessionLogEntry`), `src/core/types.ts` (`PromptBlock`).

**Определение готово (правило 7):** зелёный `bun test` + `bun run quality`;
тест, который **падал бы** без правки; для текста, видимого модели/пользователю, —
запись в `session.jsonl`, по которой видно что произошло.

---

## 4. Порядок волн (из спеки §5)

| Волна | Содержание | Закрывает |
|---|---|---|
| **W0** | Наблюдаемость (см. §3) | A, B, C, D, F |
| **W1** | Владение данными: `ToolDefinition.owner`, единый `ToolRegistry`, `PromptAssembler`, `ModuleHost` (lifecycle) + гейт архитектуры | A, E, F, M |
| **W2** | Enforcement: `ToolSecurityDecl`, проверки в `ToolExecutor.execute()`, enforcement тегов, `bash` в jail | INV-9…12 (аудит 4.1, 4.4–4.7) |
| **W3** | `ConfigStore` с эффектами вместо `reconfigure: boolean`, атомарная запись, модульные ключи | INV-18…21 |
| **W4** | ✅ Переезд `modules/context` и `modules/hallucination` в ядро, `core/api/*`, пустой allowlist направления зависимостей | INV-3, INV-4 |
| **W5** | Разбор `agent.ts` (1903 → ~1810 после MoE) на фазы `TurnCoordinator` | INV-23 |

Порядок выбран по риску, не по удобству. W1 и W2 дают эффект независимо от W5.

**W1 в работе** (спека [`2026-10-13-w1-module-host-design.md`](../specs/2026-10-13-w1-module-host-design.md),
решения §5 зафиксированы там):

- W1.1 ✅ `ModuleHost` (lifecycle/requires/critical/timeout/dispose/health/сбор).
- W1.3 ✅ владелец тула: `RegisteredTool` (`owner` обязателен по типу, INV-1/2).
- W1.4 ◐ гейт `tests/arch/module-boundaries.test.ts` (INV-3/4, 16 записей allowlist).
- W1.6 ✅ все модули на `ModuleDef` через единый `ModuleHost`: `mcp`/`lsp`/`browser`
  (+ `teardown`), `execution`/`indexer` (вотчер → `teardown`)/`memory`/`session`/`skills`;
  тулы собирает хост (`ModuleHost.collectTools`, INV-2), `dispose` на `agent.shutdown`.

**Порядок (решение 2026-10-13, вариант «сначала безопасность»):**
`lsp` → `browser` → **W2 (enforcement)** → `W1.5 PromptAssembler` → гейт **A**
(единственный путь тулов) ✅ → все модули на `ModuleDef` ✅ → W3 → W4 → W5.
`W1.2` (child-логер в модулях) схлопнут в W1.6 — логер приходит из `ModuleHost.ctx`.

**W2 в работе** (спека [`2026-10-13-w2-enforcement-design.md`](../specs/2026-10-13-w2-enforcement-design.md)):
- W2.1 ✅ `ToolDefinition.security: ToolSecurityDecl` (`caps` обязателен; `pathArgs`/
  `urlArgs`/`manual`) — объявлено для всех тулов; `bash` = `[{proc:true}]` + `manual`,
  MCP-тулы = `manual`. Гейт формы `tests/tools/security-decl.test.ts`.
- W2.2 ✅ `pathArgs` в `ToolExecutor.execute()`: scope (`isPathInScope`/`isPathWritable`)
  + protected-пути (только для записи, always-on) ДО хендлера; блок → `blocked:true` с
  `tool.path_blocked`. Тест `tests/tools/enforcement-path.test.ts`.
- W2.3 ✅ `urlArgs` в `ToolExecutor.execute()`: SSRF (`isUrlAllowed` + session-override)
  ДО хендлера, блок → `blocked:true` с `tool.url_blocked`. `attach_image` переведён
  на `manual` (source — путь **или** URL). Тест `tests/tools/enforcement-url.test.ts`.
- W2.4 ✅ правка спеки + гейт согласованности: `caps` — декларация, проверяемые
  политики привязаны к аргументам (`pathArgs`⇒fs-cap, `urlArgs`⇒net-cap).
  Привязка `proc/net` к `security.bash.enabled`/`security.network.enabled` **убрана
  как ошибочная** (это выключатели валидации, не доступа).
- W2.5 ✅ снят дубль из 13 хендлеров (read/write/edit/create/delete/move/list/file-info/
  grep/chunk/download/web-fetch/web-browse): проверки scope/protected/SSRF убраны —
  их применяет `execute()`. Резолв пути и доменная валидация (bash, размер download,
  `writePathAllowlist`, `attach_image`-manual) остались. 5 тестов, сверявших хендлерную
  блокировку, удалены как покрытые `tests/tools/enforcement-*.test.ts`.

- W1.5 ✅ единый сборщик промпта `assembleDynamicPromptBlocks`
  (`src/core/prompt-assembler.ts`, INV-16): main и раннер используют его; блок
  возможностей плагинов теперь и у раннера (раньше сборки разошлись). Тест
  `tests/core/prompt-assembler.test.ts`.

**Итог W2:** единая точка enforcement достигнута (W2.1–W2.5 ✅). Дальше по порядку —
остальные модули на `ModuleDef` → W3 → W4 → W5.

**Гейт A (единый путь тулов) сделан** отдельным шагом (до полной миграции модулей):
единственная точка записи `registerOwnedTools`/`upsertOwnedTool` в
`src/core/module-host.ts`; ядровые, модульные, раннерные, интерактивные
(`question`/`approve`) и плагинные тулы идут через неё; гейт
`tests/arch/tool-registration.test.ts` (AST, **без allowlist**). Долг `arch-gate-a` оплачен.


**Приоритет при выборе одной волны: W2.** Enforcement даёт немедленный эффект на
самый дорогой класс дефектов (безопасность) и не требует остального каркаса.
W0 — если нужна дешёвая победа и разбор следующих сессий.

---

## 5. Открытые решения (нужно решить до соответствующей волны)

> W1-решения (1–3) **решены** в [`2026-10-13-w1-module-host-design.md`](../specs/2026-10-13-w1-module-host-design.md) §4:
> синглтоны остаются процесс-глобальными (per-session — отдельная волна); падение
> `critical`-модуля валит boot (без «безопасного режима»); один `ModuleHost` на процесс
> + фасад для раннеров.

1. **W1 — глобальные синглтоны.** `processRegistry`, `globalRateLimiter`,
   `globalSecurityPolicyManager` и др. — делать per-session уже в W1 или
   достаточно владельца из `ModuleHost`? (Аудит 4.9 + 7.8.)
2. **W1 — реакция на `critical`-отказ модуля.** Падать всему boot'у или поднимать
   безопасный режим? Для `mma serve` (тенант) ответ, вероятно, другой, чем для REPL.
3. **W1 — `ModuleHost` и раннеры.** Per-session раннеры делят модули с main-агентом
   (`session-runner-scope.ts`). Два инстанса `ModuleHost` или один с фасадом?
4. **W2 — `bash`.** **Решено:** `caps:[{proc:true}]` + `manual` (валидация строки — в
   хендлере). `security.bash.enabled`/`security.network.enabled` — выключатели
   *валидации*, не доступа; привязывать к ним тулы нельзя (см. W2-спеку).

---

## 6. Долги

Единый реестр — [docs/agents/debt.md](../agents/debt.md) (правило 9: долг платится один
раз, у каждого — критерий выхода и триггер). Открыто там: `per-session-singletons`,
`doctor-command`, `w3-config-remainder`, `agent-turn-coordinator`.

Историю удаления MoE см. в [feature-history.md](../agents/feature-history.md);
live-прогон одиночного пути сделан 2026-10-12 (§2). Остальные текстовые долги
из прежних версий этого раздела переехали в реестр.

## 7. Что НЕ делать

- Не возвращать MoE «на всякий случай» — причина удаления структурная (§1 спеки).
- Не начинать с UI/lint-полировки: это даёт ощущение прогресса, не давая структуры.
- Не вводить DI-контейнер с рефлексией для `ModuleHost`: явный `requires` достаточно.
- Не чинить симптомы из аудита по одному, пока не выбран слой: большинство
  закрывается волнами W1–W2 целиком.