# MMA — recovery-сабагент на повторяющиеся ошибки тулов

**Дата:** 2026-11-21 · **Версия:** 0.26.1 · **Ветка:** `fix/validation-stall-terminal`
**Статус:** target (нормативный контракт ветки)
**Источник:** разбор сессии `ses_mwqepqz7_aujjqmetbnwbsovt` и живых прогонов
`ses_mwqga1q2_evaretxujxflfjbs` / `ses_mwqhi7pg_zsaypmldktuoligr`.

## 1. Проблема

Малая модель с выключенными рассуждениями быстро работает, но **не осмысливает** ошибку
тула. Она видит `[SECURITY BLOCKED] … Alternative: use workdir` или
`Plan does not cover files required by the task`, не делает вывода и повторяет тот же
вызов. Дальше харнесс:

1. считает эти ответы «ударами» и после 3 отключает рабочий тул (`MAX_TOOL_FAILURES_PER_TURN`);
2. пишет модели директиву «tool cannot succeed in this environment … Stop and tell the user
   what is blocking the task»;
3. накапливает `failedBatchesTotal` до терминала `stalled` и форсирует tool-less финал
   (`exec.finalize_no_tools`: «Do not request tools or ask to continue»).

Итог: модель честно сообщает «задача не завершена, инструменты отключены», хотя scaffold
Next.js уже создан, а остальные шаги выполнимы. Это и есть «агент не заставил модель
работать» — сбой не в модели, а в политике восстановления.

Текстовые директивы сами по себе не лечат: в живых прогонах одна и та же директива
игнорировалась по 3–8 раз подряд.

## 2. Инварианты

| ID | Инвариант | Гейт |
|----|-----------|------|
| **RCV-1** | Детерминированные ошибки ввода/политики (`[SECURITY BLOCKED]`, `errorMeta.retryable:false`, «Process not found», «does not cover files required») **не отключают тул**. Счётчики пакетов (honest-stop, AQC-4) не меняются: blocked-вызовы по-прежнему считаются фейлом пакета. | `tests/core/recovery-gate.test.ts` |
| **RCV-2** | При повторе одной сигнатуры ошибки ≥2 раз харнесс вызывает recovery-сабагента: свежий контекст (только ошибка + задача + доступные тулы), рассуждения включены, ответ — ровно один JSON с исправленным вызовом тула или решением `skip`. | `tests/core/recovery-client.test.ts` |
| **RCV-3** | Исправленный вызов исполняется **только** через `ToolExecutor.execute()` — общую точку allowlist, scope, path/SSRF. Обхода enforcement'а нет; сабагент не имеет привилегий основного хода. | `tests/core/recovery-gate.test.ts` |
| **RCV-4** | Каждая попытка и результат пишутся в `session.jsonl` событиями `recovery_attempt` / `recovery_result` с `source:"module:recovery"`; отказ/таймаут — fail-open с причиной, без остановки хода. | `tests/core/recovery-observability.test.ts` |
| **RCV-5** | Бounds: ≤2 попытки на сигнатуру за ход, ≤4 за ход, таймаут 20 с, `maxTokens ≤1024`, интерактивные тулы не восстанавливаются. | `tests/core/recovery-gate.test.ts` |
| **RCV-6** | Директива отключённого тула **не велит остановить задачу**: «unavailable for the rest of this turn … continue with other available tools». | `tests/i18n.test.ts`, `tests/webui-i18n.test.ts` |
| **RCV-7** | Новый публичный контракт — только события `session.jsonl` и внутренний API модуля `recovery`; формат конфига и REST/SSE не меняются (спека не требуется для конфига). | — |
| **RCV-8** | Тул, который успешно отработал хотя бы раз в этом ходе, **никогда** не отключается до конца хода: успех доказывает работоспособность, последующие отказы — ошибки аргументов. | `tests/core/recovery-succeeded-tool.test.ts` |
| **RCV-9** | Failure-based терминалы (`failed_batches`/`stalled`/`duplicate`/`silent`) **не завершают** ход: ошибка отдаётся recovery-сабагенту, стрики сбрасываются, цикл продолжается. Кап 4 вылечивания на ход. | `tests/core/recovery-terminal.test.ts` |
| **RCV-9b** | Если сабагент не предложил правку (`no proposal`), харнесс **не сдаётся**: в `<system-summary>` уходит точный текст ошибки с требованием исправить её и продолжить, стрики сбрасываются. Forced final — только после исчерпания капа RCV-9. | `tests/core/recovery-terminal.test.ts` |

## 3. Контракты и потоки

### RCV-1 — классификация ошибки

`src/core/agent/validation-failure.ts` экспортирует чистую функцию
`isValidationFailure(result: ToolResult): boolean`. Источник истины — machine-readable
поля и маркеры: `result.blocked`, `result.errorMeta?.retryable === false`, подстроки
`[SECURITY BLOCKED]`, `Process not found:`, `does not cover files required`.
Функция используется в `failure-memory.ts` (учёт фейлов тула) и `tool-batch-calls.ts`
(`anyToolFailed`), чтобы одна и та же классификация не расходилась по двум местам.

### RCV-2/3 — сабагент и исполнение

`src/modules/recovery/client.ts`: `RecoveryClient.propose(input): Promise<RecoveryProposal|null>`.
Вход: текст задачи, имя тула, каноничные аргументы, error output, список доступных тулов.
Выход: `{ call: {name, arguments}, reason } | { skip: true, reason } | null`.
Системный промпт требует **только JSON** и исправленный вызов, а не описание проблемы.

`src/modules/recovery/gate.ts`: `RecoveryGate.maybeRecover(input)`:
- ключ сигнатуры = `tool + canonicalArgsKey(name, arguments) + headline ошибки`;
- проверка лимитов RCV-5;
- вызов `RecoveryClient`;
- при `call` — вызов переданного `execute: (call) => Promise<ToolResult>` (это
  `ToolExecutor.execute()` в точке сборки цикла), запись `recovery_exec` и возврат результата
  основному циклу как обычного `tool_result`.

### RCV-4 — наблюдаемость

`source:"module:recovery"`, `operation:"recovery.attempt|recovery.exec"`,
 `kind:"ok|failed|degraded"`, `cause` — причина отказа. Fail-open: недоступный провайдер
или таймаут не меняет ход и не порождает `finalizeReason`.

### RCV-6 — формулировки

`en.json` / `ru.json`, ключи `exec.tool_disabled` и `exec.finalize_no_tools` переписываются
без «Stop and tell the user» / «Do not request tools or ask to continue». Последняя
директива сохраняет смысл «answer from what you have» только для **реально терминальных**
причин (hard cap, cost), но не для ошибок валидации.

## 4. Что явно не делается

- Forced `tool_choice` (llama.cpp откатывает к auto — см. AQC design).
- Новый тул `recovery` в catalogue — сабагент живёт как внутренний сервис, модель его не вызывает.
- Изменение `CHANGELOG.md` и версии пакета (правило 10 AGENTS.md).
- Автоматическое повторение произвольных тулов: только исправленный вызов, только через enforcement.

## 5. Порядок волн

1. RCV-1 + RCV-6 — малая волна: общая классификация и честные формулировки.
2. RCV-2/3/4/5 — клиент, гейт, лимиты, журнал, интеграция в цикл.
3. Живая проверка в `mma web` на том же стенде veloman; критерий — приложение bike-shop
   доведено до сборки за один ход без «инструменты отключены».
