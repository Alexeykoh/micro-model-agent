# Handoff: переход на Architecture v2

**Дата:** 2026-10-12 · **Ветка:** `docs/architecture-v2` · **База:** `master` (`65ba2f68`)
**Состояние:** `bun test` 3710 pass / 0 fail · `bun run quality` exit 0

Документ для следующей сессии: что сделано, где остановились, что делать дальше.
Правила работы — в [AGENTS.md](../../AGENTS.md) (переписаны, 8 пунктов).

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

Спека стоит на дисциплине до W1 (гейта `scripts/check-arch.ts` ещё нет). W0 —
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
Инвентарь fail-open путей — `docs/agents/observability.md`. **`verify_error`
вынесен отдельным шагом**: он требует расширить контракт `ToolContext.sessionLog`
(иначе верификатор не достаёт до `SessionLogger`) — по правилу 2 нужна спека.

**Следующий шаг:** W0.5 (`PromptBlock.source` + `degraded`, INV-1/6/17) или
`verify_error` со спекой на шов `ToolContext`. W0.2 — в W1 (`ModuleHost`).

**W0.5 сделана** (`feat/w0-prompt-block-owner`): `PromptBlock.source` (владелец)
+ `label` (имя блока) + `degraded?: { reason }` (INV-1/6/17). `ModuleRegistry`
штампует `source = имя модуля`; core/static-блоки получают владельца на месте
(`core`, `agents-md`, `plugin`, `plugins`). `PromptBuilder` строит метку как
`владелец: имя` (`indexer: project map`), а не обрезанную первую строку контента;
выпавший по бюджету блок несёт `reason: "budget: N tok did not fit"`. Стартовый
overflow-warning называет владельца и блок, а не только класс по `kind`.

**W0 закрыт** (кроме двух точек): `verify_error` (нужен шов `ToolContext`, W1) и
`W0.2` (`Logger.child()` — при появлении `ModuleHost`).

| Задача | Что сделать | Инвариант |
|---|---|---|
| **W0.1** ✅ | `Source = mma \| module:<name> \| tool:<name> \| core` → заполнять `OutputEvent.source` (сейчас **всегда `""`**, `output/channel.ts`) | INV-13 |
| **W0.2** | `Logger.child()` включать в модулях (сейчас **0 вызовов** по всему `src/`) | INV-13 |
| **W0.3** ✅ | `SessionLogEntry.module: string` + шаблон `module_${string}` (по образцу `onboarding_${string}`) | INV-13 |
| **W0.4** ✅ | `logError(message)` → `logError(Diagnostic { source, operation, kind, cause? })`; `cause` обязателен при `kind !== "ok"` | INV-12, INV-14 |
| **W0.5** ✅ | `PromptBlock.source` + `degraded?: { reason }`; при выпадении по бюджету лог говорит «indexer: project map (2400 ток.) не поместился», а не обрезанный текст | INV-1, INV-6, INV-17 |
| **W0.6** ◐ | Отдельные события для fail-open путей: `critic_error` ✅, `tool_attempt` ✅, `verify_error` — отдельный шаг (нужен шов `ToolContext`) | INV-12, INV-15 |

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
| **W1** | Владение данными: `ToolDefinition.owner`, единый `ToolRegistry`, `PromptAssembler`, `ModuleHost` (lifecycle) + гейт `scripts/check-arch.ts` | A, E, F, M |
| **W2** | Enforcement: `ToolSecurityDecl`, проверки в `ToolExecutor.execute()`, enforcement тегов, `bash` в jail | INV-9…12 (аудит 4.1, 4.4–4.7) |
| **W3** | `ConfigStore` с эффектами вместо `reconfigure: boolean`, атомарная запись, модульные ключи | INV-18…21 |
| **W4** | Переезд `modules/context` и `modules/hallucination` в ядро, `core/api/*`, guard направления зависимостей | INV-3, INV-4 |
| **W5** | Разбор `agent.ts` (1903 → ~1810 после MoE) на фазы `TurnCoordinator` | INV-23 |

Порядок выбран по риску, не по удобству. W1 и W2 дают эффект независимо от W5.

**W1 в работе** (спека [`2026-10-13-w1-module-host-design.md`](../specs/2026-10-13-w1-module-host-design.md),
решения §5 зафиксированы там):

- W1.1 ✅ `ModuleHost` (lifecycle/requires/critical/timeout/dispose/health/сбор).
- W1.3 ✅ владелец тула: `RegisteredTool` (`owner` обязателен по типу, INV-1/2).
- W1.4 ◐ гейт `tests/arch/module-boundaries.test.ts` (INV-3/4, 16 записей allowlist).
- W1.6 ◐ `mcp` ✅, `lsp` ✅, `browser` ✅ (единый `ModuleHost`: `setup` до сбора,
  `dispose` на `agent.shutdown`); остальные модули — далее.

**Порядок (решение 2026-10-13, вариант «сначала безопасность»):**
`lsp` → `browser` → **W2 (enforcement)** → `W1.5 PromptAssembler` → остальные
модули на `ModuleDef` → гейт **A** (единственный путь тулов) → W3 → W4 → W5.
`W1.2` (child-логер в модулях) схлопнут в W1.6 — логер приходит из `ModuleHost.ctx`.

**W2 в работе** (спека [`2026-10-13-w2-enforcement-design.md`](../specs/2026-10-13-w2-enforcement-design.md)):
- W2.1 ✅ `ToolDefinition.security: ToolSecurityDecl` (`caps` обязателен; `pathArgs`/
  `urlArgs`/`manual`) — объявлено для всех тулов; `bash` = `[{proc:true}]` + `manual`,
  MCP-тулы = `manual`. Гейт формы `tests/tools/security-decl.test.ts`.
- W2.2 ✅ `pathArgs` в `ToolExecutor.execute()`: scope (`isPathInScope`/`isPathWritable`)
  + protected-пути (только для записи, always-on) ДО хендлера; блок → `blocked:true` с
  `tool.path_blocked`. Тест `tests/tools/enforcement-path.test.ts`.
- W2.3–W2.5 ⬜ — `urlArgs` (SSRF), `caps` (`proc`/`net`), снятие дублей из хендлеров.


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
4. **W2 — `bash`.** Он не может быть валидирован по `pathArgs` (команда, не путь).
   Оставить `manual: { reason }` или закрыть через `command-validator` в enforcement?

---

## 6. Долги, зафиксированные осознанно

- **`scripts/check-arch.ts` не существует.** Инварианты §1 спеки держатся на
  дисциплине до W1. Перечень будущих проверок — §6 спеки.
- **`.arch-allowlist.json` не создан.** Файлы >300 строк пока перечислены текстом
  в AGENTS.md (правило 6): `agent.ts`, `repl.ts`, `line-editor.ts`,
  `stuck-detector.ts`, `execution/module.ts`, `registry-extra.ts`,
  `settings-api.ts`, `turns.ts`.
- **`agent.ts` 1903 → ~1810 строк.** Остаётся в allowlist до W5.
- **Live-прогон удаления MoE — сделан 2026-10-12** (§2). Гвард
  `tests/no-moe-surface.test.ts` держит поверхность; параллельные сабагенты,
  plan/criteria, гейты и enforcement подтверждены живым прогоном. Единственное,
  что не гоняли end-to-end, — abort (покрыт юнит-тестами одиночного пути).
- **16 удалённых тестовых файлов** проверяли второй путь. Часть сценариев
  (abort, observability, criteria) не имела аналогов для одиночного пути —
  при W0/W5 стоит проверить, что покрытие не просело: `git show --stat c3bc9d3e`.
  Сертификация: три MoE-сценария заменены одним одиночным (`7.2-parallel-subagents`),
  тег `moe` убран из `CertTag`/`TAGS`.

## 7. Что НЕ делать

- Не возвращать MoE «на всякий случай» — причина удаления структурная (§1 спеки).
- Не начинать с UI/lint-полировки: это даёт ощущение прогресса, не давая структуры.
- Не вводить DI-контейнер с рефлексией для `ModuleHost`: явный `requires` достаточно.
- Не чинить симптомы из аудита по одному, пока не выбран слой: большинство
  закрывается волнами W1–W2 целиком.