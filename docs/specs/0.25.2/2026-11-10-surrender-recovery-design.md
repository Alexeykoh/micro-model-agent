# Surrender-recovery: агент не сдаётся при недоступном инструменте

Дата: 2026-11-10. Версия: **0.25.2** (PATCH — правки поведения существующих контрактов,
без новых команд/тулов/ключей). Мотивация: живая сессия на корпоративной Windows-машине
(проект `corp_portal/frontend`, модель `deepseek-v4.1-flash`, провайдер `opencode-go`):
при миграции Angular агент упёрся в `[process error] ENOENT … uv_spawn 'C:\WINDOWS\system32\cmd.exe'`,
после чего не попробовал ничего другого и выдал «Итог: шаги не завершены». Критик не отреагировал.
Полный разбор — в отчёте 2026-11-10 (ниже §Проблема).

## Проблема

1. **Ложный хинт при недоступном шелле.** `processRegistry.start()` спавнит с `shell: true`
   (`src/modules/processes/registry.ts:78`); на Windows это `cmd.exe`. Если `cmd.exe` недоступен
   (политика, AppLocker, битый `ComSpec`), падает **сам шелл**, а `bash`-тул отвечает
   `Hint: check the "workdir" path exists and the command is valid for this OS`
   (`src/tools/bash-process.ts:69-73`) — модель отправляется проверять workdir, который в порядке.
2. **`exec.honest_stop` запрещает смену подхода.** Текст (`src/i18n/ru.json:1026`) говорит
   «НЕ пробуй другую команду, флаг или обход» и «напиши финальный ответ СЕЙЧАС». При сломанном
   шелле правильный ход — сменить **класс** инструментов (file tools вместо shell), но директива
   запрещает именно это. Наблюдение: финальный ответ агента дословно повторяет структуру
   директивы («что сделано / что НЕ сделано»).
3. **Сданная директива остаётся в контексте.** `clearDirective()`
   (`src/core/agent/directives.ts:49-52`) снимает только запись из реестра стоящих директив;
   уже инжектированное `<system-summary>` сообщение живёт в истории до компакции. Успешный
   пакет (`tool-batch-signals.ts:129-135`) сбрасывает счётчик, но модель продолжает читать
   «НЕ пробуй… напиши финальный ответ».
4. **Критик слеп к незавершённому плану.** `EvidencePack` (`src/modules/critic/evidence.ts`)
   несёт `planSummary` одной строкой (`plan-prompt.ts:27-48` — «N/M готово, текущий: шаг K»),
   списка незакрытых шагов нет. Промпт (`src/modules/critic/client.ts:12-22`) при недостатке
   улик требует `ok` («prefer silence over noise»), а fail-open при таймауте бюджета
   (`CRITIC_GATE_BUDGET_MS = 45_000`, `src/config/timeouts.ts:26`) неотличим от «проверил и
   сказал ок» вне `session.jsonl` (локальные сессии: 3× `no verdict (degraded, timedOut)`).
5. **Форс-финал не проходит аудит.** При `finalizeReason` (failed_batches / stalled / duplicate /
   silent / cost) и при исчерпании итераций `executeAgentLoop` вызывает
   `finalizeWithoutTools` + `criticGate` (`src/core/agent/loop-run.ts:210-254`), **минуя
   `auditGate`** — тот стоит только в `runFinalGates` для итераций без тулов
   (`src/core/agent/loop-gates.ts:166-176`). Самый рискованный ход остаётся без детерминированной
   проверки плана (INV-C7 закрывает для критика, для аудита — нет).

## Решение

Шесть задач S1…S6 — каждая отдельной веткой от `dev` (правило 3). Порядок: S1 → S2 → S3 → S4,
параллельно S5 → S6.

### S1. Честная классификация ошибки спавна (`fix/bash-shell-unavailable`)

Новый чистый хелпер `src/tools/bash-spawn-error.ts`:

- `classifySpawnError(message: string, platform: NodeJS.Platform): "shell" | "workdir" | "unknown"` —
  по тексту `entry.spawnError`: совпадение с `uv_spawn`/`ENOENT` и именем шелла (`cmd.exe`,
  `ComSpec`, `sh`, `bash`) → `"shell"`; с путём workdir → `"workdir"`; иначе `"unknown"`.
- `bash-process.ts` на `"shell"` отдаёт текст `bash.shell_unavailable`
  (**без** ложного «проверь workdir»): шелл недоступен на этой машине — все shell-вызовы
  упадут одинаково; используй файловые тулы (`read_file`/`write_file`/`edit_file`/`glob`/`grep`/
  `list_dir`), если без шелла не обойтись — один короткий вопрос пользователю через `question`.
  На `"workdir"` — прежний хинт (он корректен), на `"unknown"` — общий.
- Счётчик подряд идущих `"shell"`-падения в `src/tools/bash-failures.ts` (WeakMap на контекст
  прогона, как `failureCounters`), порог `SHELL_STOP_THRESHOLD = 3`: с третьего раза тул
  **не спавнит**, а сразу возвращает тот же текст — повторный спавн заведомо падает, итерации
  жалеть нечем. Счётчик обнуляется любым успешным bash.
- Системный промпт не трогаем: `SECURITY BLOCKED`-блок (`system-prompt.ts:188`) — про blacklist,
  не про недоступность шелла; новый текст приходит модели в результате тула ровно там, где боль.

### S2. Быстрая директива «смени класс инструментов» (`fix/stuck-shell-class`)

- `StuckObservations.recordBashAttempt(success, shellUnavailable?)`: отдельный счётчик
  `shellUnavailableStreak` (по классификатору S1 — не парсингом строк), сброс на успехе.
- Новый предикат `hasShellUnavailable()` (порог 2 — до полного окна flailing 4/6),
  новый `PrimaryReason "shell-unavailable"` в приоритетной цепочке
  (`stuck-recovery.ts:38-46`: после `stuck`, до `tool-errors`) + `FailureType`
  `"shell_unavailable"` в `stuck-signals.ts`.
- `exec.shell_unavailable_recovery`: «shell на этой машине недоступен — не трать вызовы bash;
  за записями файлов иди в read_file/glob/grep; команда нужна пользователю — спроси один раз».
  Инжект — тем же путём `issueDirective` (переживает компакцию, снимается при успехе — S4).
- `plugin-think.ts`: условие инжекта recovery расширяется `hasShellUnavailable()`.

### S3. Переписать `exec.honest_stop` (`fix/honest-stop-wording`)

Новая семантика (en+ru, та же длина ≤3 строк):

1. серия {count} пакетов упала/заблокирована — **тот же самый вызов** повторять бессмысленно;
2. прежде чем отвечать — попробуй **другой класс** инструментов (file tools вместо shell;
   `plan_step status=skipped` для невыполнимого; один `question`);
3. финальный честный ответ — только когда ни один из пунктов не применим; в нём — что сделано,
   что не сделано и почему, без выдуманных результатов.

Формулировка «НЕ пробуй другую команду, флаг или обход» уходит: она блокировала единственно
правильное поведение. Гварды по фразе (`tests/core/tool-batch-honest-stop.test.ts` сверяет
`finalize`, не текст) не ломаются; текстовые ожидания тестов обновить вместе.

### S4. Снятая директива уходит из контекста (`fix/directive-supersede`)

- Контракт `DirectiveSink` дополняется `supersedeDirective?(id: string): void`.
  `clearDirective()` вызывает его после `clearStandingDirective`.
- `ContextManager.supersedeDirective(id)`: по тексту из реестра стоящих директив находит
  **последнее** user-сообщение `<system-summary>` с этим текстом и вычёркивает из активной
  истории (tool-пары не трогаем: директивы никогда не бывают `role:"tool"`; соседние
  assistant(tool_calls) не сдвигаем). Текста нет в истории (компакция уже съела) — no-op.
- Эффект: `honest_stop`/`failed_batches`/`consecutive_failures` не живут в контексте после
  того, как условие снялось, — противоречивых сигналов («сдайся» + «работает дальше») меньше.

### S5. Критик видит незакрытые шаги и честный отказ (`fix/critic-plan-evidence`)

- `AgentDeps.planSummary` дополняется `planPendingSteps?: () => string[]`
  (`ExecutionModule.getPlanPendingSteps()` — те же `isUnconfirmed`-критерии, что у
  final-audit: `final-audit.ts:89-95`, переиспользовать, не дублировать).
- `CriticGateDeps.planPendingSteps` → `buildEvidencePack` (`evidence.ts`) кладёт в
  `EvidencePack.planPendingSteps: string[]` (кап 8, `+N more`); `client-render.ts renderPack`
  печатает `PLAN PENDING STEPS: …`.
- `CRITIC_SYSTEM_PROMPT` — два правила:
  - незакрытые шаги плана + нет работы, их закрывающей → `critical` («честно сказать „не
    сделал“» само по себе не спасает, если тулы для работы были доступны);
  - `critical` **не** ставится, когда evidence показывает недоступность инструмента
    (сигнатура `shell unavailable`/`SECURITY BLOCKED` в tool trail) и ANSWER просит
    пользователя/`plan_step skipped` — это `concern` с suggestion, а не fabrication.
- Деградация критика остаётся fail-open, но с видимым следом: строка `ui.critic_skipped`
  уже идёт в ленту (`critic-degrade-line.ts`); дополнить: `stopReason` форс-финалов и статус
  `critic_verdict.status="none"` остаются единственным источником — новых UI-полей не вводим.

### S6. Аудит на форс-финале (`fix/audit-force-final`)

- В `executeAgentLoop` после `finalizeWithoutTools` + `criticGate.evaluate` (S0 уже гоняет
  критика на форс-финале) прогнать `auditGate.evaluate` в тех же лимитах `MAX_AUDIT_RETRIES`:
  `reject` → один дополнительный форс-вызов (критик/аудит уже заплатили свои), `pass` → как
  сейчас, `exhausted` → `auditFailed` (success:false, `error.audit_failed`).
- Детерминированный аудит закрывает дыру, где LLM-критик таймаутит: «шаги 13–17 не закрыты»
  виден без бюджета и без вердикта.
- `finalizeWithoutTools` остаётся без гейтов внутри — гейты живут в оркестраторе (`loop-run`).

## Что НЕ делаем

- **Проба reasoning/context** — не здесь: отдельная ветка `fix/provider-context-reasoning`
  (в т.ч. честный tri-state `true/false/null` вместо схлопывания `null→false`
  в `provider-phase.ts:239` — из-за этого на скриншоте «думаю · default»).
- Не сокращаем системный промпт и не перекраиваем состав блоков (карта/скиллы/MCP/память
  ошибок) — тема отдельной спеки про перегруз промпта; в 0.25.2 только точечные правки S1…S6.
- Не вводим новых ключей конфига: пороги (`SHELL_STOP_THRESHOLD`, streak S2) — константы
  модулей с JSDoc-обоснованием, как остальные в `constants.ts`.
- Не трогаем whitelist/blacklist-политику и `[SECURITY BLOCKED]` — enforcement не меняется.

## Гварды (правило 5)

- `tests/tools/bash-spawn-error.test.ts` — классификация `cmd.exe`/workdir/unknown;
  на `"shell"` в выводе нет «check the workdir»; с 3-го подряд `shell`-падения спавн не
  вызывается (мок реестра), успех обнуляет счётчик.
- `tests/modules/execution/stuck-shell-unavailable.test.ts` — streak≥2 поднимает
  `"shell-unavailable"` в `primaryReason` выше `tool-errors`; recovery-текст содержит
  указание на файловые тулы; сброс на успехе.
- `tests/core/honest-stop-wording.test.ts` — `exec.honest_stop` содержит «другой класс
  инструментов»/`plan_step status=skipped` и НЕ содержит «НЕ пробуй другую команду»
  (en+ru паритет ловит `tests/i18n.test.ts`).
- `tests/core/directive-survives-compaction.test.ts` — расширить: после `clearDirective`
  текст `<system-summary>` исчезает из активной истории; компакция не ломает
  assistant(tool_calls)↔tool-пары (`tests/replay/invariants.test.ts` остаётся зелёным).
- `tests/critic-plan-evidence.test.ts` — pack включает `planPendingSteps` ≤8 + `+N more`;
  `renderPack` печатает `PLAN PENDING STEPS`; два новых правила в `CRITIC_SYSTEM_PROMPT`.
- `tests/core/audit-force-final.test.ts` (падает до правки): ход, завершённый форс-финалом
  `failed_batches` при активном плане с незакрытыми шагами, не может вернуть `success:true`
  без пройденного аудита; `pass` после аудита — `success:true` как сейчас.
- `bun run quality` + `bun test` зелёные; живой прогон S1/S2 — на машине с отключённым
  `cmd.exe` (песочница `MMA_CONFIG_DIR`): агент после `shell unavailable` идёт в `glob`/
  `read_file`, а не в «Итог: не завершено».

## CHANGELOG 0.25.2 (каркас записи)

- **Fixed**: bash — при недоступном шелле больше не винит workdir; 3-е подряд падение не
  спавнит команду.
- **Fixed**: honest-stop directive больше не запрещает смену класса инструментов; снятая
  директива убирается из контекста.
- **Fixed**: критик получает незакрытые шаги плана; аудит прогоняется на форс-финале.
- **Added (tests/guards)**: перечисленные выше файлы тестов.
