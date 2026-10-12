# Удаление MoE: один путь исполнения

**Дата:** 2026-10-12 · **Ветка:** `docs/architecture-v2` (в рамках architecture v2) · **Статус:** выполнено (`c3bc9d3e`)
**Связано:** [architecture v2](./2026-10-12-architecture-v2-design.md) §1 (INV-22),
§3.8, §5 (волна W5) · [схемы](./2026-10-12-architecture-v2-schematics.md) §3 ·
[аудит модулей](../analysis/2026-10-12-harness-module-audit.md) §5.1–5.7, 5.14

**Причина.** MoE — не фича, а **второй харнесс**: `runWithMoE` подменяет одиночную петлю
целиком, и `HallucinationGate` / `CriticGate` / `AuditGate` / `finalizeWithoutTools` не
вызываются (аудит 5.1). Пока второй путь жив, каждое усиление петли пишется дважды, а
защита от обхода гейтов остаётся «не забыть при вызове».

Почему это стоит снять, а не чинить:
- MoE **выключен по умолчанию** (`defaults.ts: moe.enabled: false`) — отказ стоит нуля
  для пользователей, которые его не включали;
- **не работал** ни разу за всё время разработки — нет живых прогонов, которые он улучшил;
- его ценность уже получена другим путём: `ToolDefinition.parallelizable` +
  `ToolExecutor.fork()` + per-expert провайдеры + `expert_tag` дают параллельных сабагентов
  **через тот же харнесс** — с allowlist, таймаутами, enforcement и плагин-хуками;
- ~2200 строк оркестратора (`agent-moe` 531 + `moe-executor` 620 + `orchestrator` 402 +
  `verifier`-часть + `plan-validator` 254 + `input-from` 85 + `moe-parallelism` 66 +
  `expert-model-check` 92);
- **8 из ~15 самых дорогих находок аудита — MoE** (5.1–5.7, 5.14).

**Что это НЕ трогает.** `experts` (конфиг), `expert-provider.ts`, `expert_tag` в `subagent`,
`StepVerifier.verifyStep`, тул `verify`, план-трекер, `plan-`/`plan_step`/`todo`.
Они работают в одиночном пути и остаются.

---

## 1. Что правильно после удаления

- **`INV-22` становится выполнимым:** путь выполнения хода **один**. МоE-ветки нет —
  значит, обойти контур гейтов структурно невозможно, а не «по договорённости».
- Параллелизм остаётся и становится **дешёвым**: `parallelizable: true` на `subagent`
  уже реализован в `ToolBatchExecutor` и проходит через `ToolExecutor.execute()`.
- Per-expert провайдеры и `expert_tag` сохраняются: модель может звать
  `subagent { expert_tag: "web" }` и получить сабагента на отдельной модели с отдельным
  набором тулов — без оркестратора, re-plan циклов и второго харнесса.
- Machine-readable критерии (`file-exists:`, `command-exit-0:`) остаются в
  `plan`/`verify` — но вызываются из петли, а не из отдельного верификатора сабтасков.

## 2. Что удаляется

### Файлы

| Файл | Строк | Причина |
|---|---|---|
| `src/core/agent-moe.ts` | 531 | второй путь хода |
| `src/modules/execution/moe-executor.ts` | 620 | второй исполнитель волн |
| `src/llm/orchestrator.ts` | 402 | оркестратор-планировщик |
| `src/modules/execution/plan-validator.ts` | 254 | валидатор MoE-планов |
| `src/modules/execution/input-from.ts` | 85 | зависимости сабтасков |
| `src/modules/execution/expert-model-check.ts` | 92 | сверка моделей экспертов для MoE |
| `src/modules/execution/moe-parallelism.ts` | 66 | параллелизм MoE-волн |

### Контракты

- `MoEConfig`, `MoEPlan`, `MoESubtask`, `MoEPlanTask`, `SubtaskResult`, `MoEVerifyResult`,
  `OrchestratorConfig`, `OrchestratorResult`, `MoEDeps` и прочие MoE-типы
  (`src/config/types.ts`, `src/modules/execution/types.ts`, `src/llm/orchestrator.ts`).
- Ключи конфига: `moe.enabled`, `moe.maxReplanCycles`, `moe.parallelSubtasks`,
  `orchestrator.model`, `orchestrator.provider`, `orchestrator.contextWindow`.
- События `session.jsonl`: `moe_plan`, `moe_subtask`, `moe_replan`, `moe_verify`.
- `AgentResult.moeHandled`, `AgentDeps.runWithMoEOverride`, `AgentDeps.onMoEState`,
  `Agent.setMoEStateListener`.
- Публичные экспорты `OrchestratorClient` / `OrchestratorConfig` из `src/index.ts`
  и `src/llm/index.ts` — это breaking change для внешних плагинов (см. §4).
- Веб: чип `MoE` в футере, `HostStateSnapshot.moeActive`, `WebUiState.moeSessions`,
  секция настроек `agent.moe`, строки trace `moe_*`, SSE-ветки.

### Что остаётся

| Актив | Почему |
|---|---|
| `ToolDefinition.parallelizable` + `ToolExecutor.fork()` | параллельные сабагенты в том же харнессе |
| `config.experts` + `src/modules/execution/expert-provider.ts` | per-expert модель/провайдер |
| `subagent { expert_tag }` | роутинг сабагента к эксперту |
| `StepVerifier.verifyStep` + тул `verify` | проверка шага плана |
| `plan` / `plan_step` / `todo` + трекер + план-стори | планирование |
| `transient-error.ts` (`isTransientError`, `isInfraError`) | используется `stuck-detector` и `run-task.ts` |

## 3. Побочные правки

1. `src/modules/execution/verifier.ts` — удалить `verifySubtaskCriteria` и импорт MoE-типов;
   `verifyStep` не трогаем.
2. `src/modules/providers/managed.ts` — `orchestrator.contextWindow` был глобальным фолбэком
   для per-entry контекста; заменяется на дефолт модуля, иначе `experts[].model`
   получает неверное окно.
3. `src/tools/subagent.ts` — убрать хак «top-level сабтаска гасит `moe.enabled`»
   (строки ~237–242): переменной `moe` в конфиге больше нет.
4. `src/modules/execution/module.ts` — `plan-coverage`/`plan-checks` не трогаем; убираем
   только MoE-импорты.
5. i18n — удалить ключи `moe.*` и `web.settings.sec.agent.moe*` из `en.json`/`ru.json`
   симметрично (`tests/i18n.test.ts` проверяет симметрию).

## 4. Обратная совместимость

| Что | Политика |
|---|---|
| `moe.*` / `orchestrator.*` в чужом `config.json` | ключи становятся неизвестными и просто игнорируются при загрузке (`deepMerge` без валидации). Ошибки нет |
| `OrchestratorClient` в `src/index.ts` | удаляется. Внешних плагинов на него нет (проверено: `examples/plugins/**` не импортирует). Фиксируется в CHANGELOG как Removed |
| `moe_*` в старых `session.jsonl` | тип записи остаётся допустимым при чтении (`log-api` whitelist снимаем, но парсер остаётся терпимым к неизвестным типам) — старые сессии должны открываться |
| Значения `experts` | не трогаем |

## 5. Порядок работ

Каждый шаг — отдельный коммит, `bun test` + `bun run quality` зелёные.
Выполняется в ветке `docs/architecture-v2`, коммиты идут подряд.

| # | Шаг | Что проверяется | Статус |
|---|---|---|---|
| 1 | Удалить 7 файлов; вычистить `agent.ts` (ветка MoE, `AgentDeps.runWithMoEOverride`, `onMoEState`, `setMoEStateListener`) и `AgentResult.moeHandled` | `bun test` | ✅ |
| 2 | Конфиг: убрать `moe.*`/`orchestrator.*` из `types.ts`, `defaults.ts`, `registry-extra.ts`, `domains.ts` | `tests/config*.test.ts` | ✅ |
| 3 | Типы/лог: убрать MoE-типы из `execution/types.ts`, `SessionLogger.logMoE`, `moe_*` из `session/store.ts` и `webui/session/log-api.ts` | `tests/session-logger.test.ts`, `tests/webui-log.test.ts` | ✅ |
| 4 | Веб: `footer.ts`, `sidebar.ts`, `state.ts`, `host-state.ts`, `webui/module.ts`, `sessions-api.ts`, секция `agent.moe`, строки trace | `tests/webui-*.test.ts` | ✅ |
| 5 | i18n: удалить `moe.*` / `web.settings.sec.agent.moe*` симметрично | `tests/i18n.test.ts` | ✅ |
| 6 | Публичные экспорты `OrchestratorClient`/`OrchestratorConfig` | `bun run typecheck` | ✅ |
| 7 | Тесты: 16 MoE/оркестраторных файлов удалены, затронутые поправлены | `bun test` | ✅ |
| 8 | `subagent.ts`: хак «top-level сабтаска гасит `moe.enabled`» убран | `tests/subagent*.test.ts` | ✅ |
| 9 | Доки: AGENTS.md, feature-history, CHANGELOG | ревью | ✅ |
| 10 | Зачистка остатков поверхности MoE: dead-поле `moeActive`, тип `SubtaskContext`, `.ws-moe` CSS, cert-тег `moe`, фикстуры тестов, призрачные комментарии; гвард `tests/no-moe-surface.test.ts` | `bun test`, `bun run quality` | ✅ (`chore/moe-closeout`) |

Порядок не произвольный: шаги 2–6 оставляют код **компилируемым и зелёным** после
каждого коммита, шаг 7 — последний, потому что падающие тесты видят весь срез правок.
Шаг 10 добавлен после прожарки (grill-me): механизм MoE был снят в `c3bc9d3e`,
но поверхность (типы/чипы/сертификация/комментарии) оставалась и могла вернуться
незамеченной — теперь её держит гвард-тест (правило 5).

## 6. Что НЕ делаем

- Не переносим re-plan оркестратора в план-модуль: `plan update` / `plan_step` уже
  покрывают перепланирование, а `carriedResults`-по-id (аудит 5.7) — источник багов,
  а не возможностей.
- Не добавляем «лёгкий MoE» на базе сабагентов: параллельные вызовы `subagent` уже
  доступны модели через `parallelizable`, без нового кода.
- Не трогаем `parallelizable`/`fork()` — это и есть то, что остаётся от MoE.

## 7. Ожидаемый эффект

- Петля становится **одной**: W5 спеки architecture v2 (фазы) упрощается — вместо
  «общего VERIFY для двух путей» остаётся один путь без развилки.
- `agent.ts` теряет ~90 строк MoE-ветки и 2 поля `AgentDeps` (1903 → ~1810 строк),
  но остаётся в allowlist до полного разбора на фазы.
- ~2200 строк рантайма и ~14 тестовых файлов удаляются.
- Уходит поверхность, где отказ выглядел как успех (5.6), где Esc не останавливал волну
  (5.2), где таймаут сабтаска не применялся (5.3) и где результаты сабагентов
  выбрасывались (5.5).