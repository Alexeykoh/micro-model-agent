# Наблюдения за маленькими моделями (Small Model Quirks)

> **Назначение:** этот файл — журнал систематических особенностей поведения маленьких моделей
> (Qwen3.5-9B и подобных) в harness MMA. Каждая запись = наблюдаемое поведение + где оно
> проявилось + как harness на это реагирует (или должен).
>
> **Правило:** при обнаружении нового систематического «прикола» модели — добавь запись сюда.
> Не исправляй поведение точечным костылём, не зафиксировав наблюдение в этом файле: паттерны
> повторяются между сессиями и сценариями, и знание о них должно пережить рефакторинги.
> См. раздел в AGENTS.md.

Формат записи:

```
## <дата> — <короткое название>
- **Симптом:** что модель делает (наблюдаемое поведение)
- **Где проявилось:** сессия / сценарий сертификации / задача
- **Реакция harness:** существующий механизм или сделанный фикс
- **Статус:** fixed / workaround / open
```

---

## 2026-08-25 — Файлы создаются через bash вместо write_file

- **Симптом:** маленькая модель интерпретирует «Create file X» как shell-команду и создаёт файлы
  через `bash` (`echo ... > file`, heredoc `cat > file <<EOF`), а не через инструмент `write_file`.
- **Где проявилось:** сертификация qwen3.5-9b, сценарии `3.5-data-pipeline` (план stuck на 1/4,
  файлы на диске есть) и `3.8-glob-find` (4/5, `glob-result.txt` создан, но шаг pending).
- **Механика сбоя:** auto-advance плана срабатывал только после `write_file`/`edit_file`
  (`execution-plugin.ts`). После bash план не продвигался; модель сама `plan update` не вызывала;
  финальный аудит честно возвращал задачу в цикл, но продвинуться было нечем → исчерпание ретраев.
- **Реакция harness:** auto-advance теперь срабатывает после каждого успешного
  **файл-мутирующего** тула (`FS_MUTATING_TOOLS`: write/edit/delete/move/create_dir/bash/
  download/subagent/mcp/pipeline/browser). Read-only тула исключены специально: успешный
  `read_file` иначе засчитал бы шаг «Update X», чей файл уже существует с прошлого шага.
- **Статус:** fixed (тесты в `tests/execution-plan-deliverables.test.ts`, блок
  «auto-advance after non-file tools»).

---

## Общие паттерны (сводка)

| Паттерн | Проявление | Контрмера в harness |
| --- | --- | --- |
| Shell-first мышление | файлы/удаления через bash вместо тулов | FS_MUTATING_TOOLS auto-advance; windows-commands hard-stop |
| Короткие финальные ответы («Done») | < 5 слов → hallucination warn/retry | exitOnComplete break только на retry+text |
| Забывает `plan update` для безфайловых шагов | шаги «run X» висят pending | auto-advance по артефактам; test-runner инъекции |
| Теряет план после компакции | пересоздаёт план / повторяет работу | `[Plan:]` в compaction summary; create-guard от перезаписи |
| Повторяет упавшую команду с небольшими вариациями | flailing | bash-flailing window detector (StuckDetector) |
| Заявляет успех без проверки (выдуманный вывод, «валиден») | success-claim без tool-подтверждения | artifact-claim + output-provenance чеки в hallucination-gate |
| Не останавливает retry-петлю после блоков | перебор вариантов заблокированной команды | honest-stop директива + hard-stop по стрику провальных батчей |

---

## 2026-08-25 — Reasoning-only ответы на этапе верификации (empty-response loop)

- **Симптом:** после фактического завершения задачи модель уходит в цикл перечитываний
  (`read_file` одного файла 2-3 раза подряд) и отвечает reasoning-only контентом без текста
  и без tool calls. `MAX_EMPTY_RESPONSE_RETRIES=2` исчерпывается → run завершается с
  `success: false` и «no output», хотя ВСЕ артефакты созданы корректно.
- **Где проявилось:** живые прогоны сертификации qwen3.5-9b, сценарий `3.5-data-pipeline`
  (`_testing/cert-fix-3.5c`): скрипт выполнен, `output.json` отфильтрован верно, но финального
  ответа нет — exit code 1.
- **Реакция harness:** пока только empty-response guard + nudge. Кандидаты на фикс: поднять
  лимит пустых ответов, при empty-response инжектировать директиву «задача проверена — ответь
  текстом», учитывать завершённость плана как критерий успеха.
- **Статус:** open.

## 2026-08-25 — Обрезка генерации лимитом completion tokens (4096)

- **Симптом:** reasoning-тяжёлые модели (qwen3.5-9b в LM Studio) упираются в дефолтный
  `max_tokens: 4096`: ответ обрезается посреди tool_call или до всякого контента. После 2
  recoverable-ретраев сессия умирает, задача не доделана.
- **Где проявилось:** `_testing/cert-fix-3.5` (первый прогон 3.5-data-pipeline); повторно —
  сертификация 2026-08-25, сценарий 3.5 rep 2/3: даже кап 12288 срезал tool_call посреди
  аргументов (успешные итерации тратят <100 completion-токенов, но модель эпизодически
  уходит в reasoning на 12K+). Для сертификации кап поднят до 16384
  (`PROVIDER_BASE` в `scenarios.ts`).
- **Реакция harness:** (1) recoverable-ошибка обрезки кормится модели обратно
  (`error.llm_truncated*`, MAX_LLM_ERROR_RETRIES=2); (2) ключ `maxCompletionTokens`
  добавлен в конфиг провайдера (`provider.entries[].maxCompletionTokens` / legacy flat
  `provider.maxCompletionTokens`) и прокинут через ProviderManager → presets →
  OpenAICompatProvider + agent.reconfigure(). До этого i18n-сообщение об ошибке ссылалось
  на несуществующий конфиг-ключ.
- **Статус:** fixed (plumbing); дефолт 4096 не менялся — поднимать пользователю/сценарию.

## 2026-08-25 — Шаги-описания бандлят несколько артефактов (all-tokens gate)

- **Симптом:** модель пишет шаг «Создать src/process.ts … записи в output.json» — auto-advance
  требует существования ВСЕХ токенов, но `output.json` появится только после запуска скрипта
  (следующий шаг). Шаг висит pending даже после записи process.ts.
- **Где проявилось:** все прогоны 3.5-data-pipeline.
- **Реакция harness:** частично компенсируется фиксом FS_MUTATING_TOOLS — успешный `bash`
  (запуск скрипта, создавшего output.json) триггерит повторную проверку текущего шага, и шаг
  продвигается сразу после выполнения скрипта. Полностью проблема снята бы пословным
  продвижением или явным `plan update`.
- **Статус:** workaround (FS_MUTATING_TOOLS).

<!-- Добавляй новые записи выше этой строки, придерживаясь формата. -->

## 2026-08-25 - Сценарий 3.5 завершён правильно, но убит таймаутом репа (медленные reasoning-модели)

- **Симптом:** сертификация `3.5-data-pipeline` падает с "rep N timed out" на медленных локальных
  reasoning-моделях, хотя песочница после прогона содержит ВСЕ правильные артефакты
  (data/input.json, корректный src/process.ts, output.json с правильной фильтрацией >50, план 3/3).
- **Где проявилось:** сертификация qwen3.6-35b-a3b (LM Studio, localhost:1234), 2026-08-25 —
  rep 1 полного прогона и rep 1 точечного перезапуска; та же картина ранее на qwen3.5-9b.
- **Причина:** модель делает LLM-вызов по 30–45 сек (reasoning + медленная генерация),
  сценарию нужно ~12 итераций ≈ 350–450с, а дефолтный таймаут репа в харнессе — 300с.
  Работа завершена, но финальный ответ модель отдать не успевает → фактчекер видит timedOut.
- **Реакция harness:** per-scenario `timeoutMs` в CertScenario (+ YAML `timeoutMs`, валидация >= 1000)
  и CLI-флаг `--timeout <ms>`; приоритет: scenario.timeoutMs → opts.timeoutMs → 300_000.
  Сценарию 3.5 выставлен timeoutMs: 600_000.
- **Статус:** fixed.

## 2026-08-25 - Модель «сдаётся» после блокировки plan update и отвечает, не завершив работу

- **Симптом:** после 1–2 блокировок `plan update status=done` гейтом деливераблов
  («файлы шага ещё не существуют») модель не выполняет очевидное продолжение
  (запустить скрипт, создающий файл), а возвращает короткий финальный текстовый ответ
  вида «задача выполнена».
- **Где проявилось:** сертификация `3.5-data-pipeline`, qwen3.6-35b-a3b (rep 2, 2026-08-25):
  process.ts написан, LSP чистый, но скрипт не запущен → output.json отсутствует.
  Ранее та же картина на qwen3.5-9b.
- **Реакция harness:** усугубляющий баг харнесса исправлен — шорткат `--exit-on-complete`
  («стоп на первом непустом ответе» при hallucination-retry) в `agent.ts` больше НЕ обходил
  финальный аудит-гейт при активном плане (`!this.deps.finalAudit` в условии): аудит
  отклоняет преждевременный ответ, модель получает `<system-summary>` с pending-шагами
  и шанс доделать (ограничено MAX_AUDIT_RETRIES / MAX_HALLUCINATION_RETRIES).
- **Статус:** fixed (тест «exitOnComplete does not bypass the audit gate» в tests/core/agent.test.ts).

## 2026-08-25 — Dynamic reasoning control: reasoning strategy и probe

- **Симптом:** модели с reasoning (Qwen3.5-9B, DeepSeek-R1) всегда генерируют reasoning_content
  даже при `reasoning_effort: "none"`, т.к. llama.cpp/xinference не передают effort-параметр
  в бэкенд. Prompt-tag стратегия (`/no_think`) может быть проигнорирована.
- **Где проявилось:** реализация dynamic reasoning control (spec `docs/specs/2026-08-25-dynamic-reasoning-control.ru.md`).
- **Реакция harness:** three-layer design:
  1. **EffortMechanism** — probe при старте проверяет, уважает ли бэкенд effort-сигнал.
     Если нет → prompt-tag (`/no_think`) как fallback.
  2. **ReasoningPolicy** — structural signals (hallucination retry, audit rejection,
     recoverable LLM error) только через harness, не через текстовый анализ (rule #10).
  3. **set_thinking tool** — агент может принудительно изменить уровень для сложных подзадач.
- **Статус:** implemented.

---

## 2026-09-28 — Выдуманный успех и неостанавливаемая retry-петля (mma web, qwen3.5-9b)

- **Симптом:** (а) модель показывает вывод программы, который не получал ни один тул
  (FizzBuzz: запуск упёрся в blacklist `python`, «показанный вывод» содержал неверные значения);
  (б) заявляет «валидный XML» про файл с mismatched-тегом (schema.drawio: самозакрытый
  `<diagram/>` + лишний `</diagram>`); (в) после двух `[SECURITY BLOCKED]` перебирает
  варианты той же команды (python → python3 → bun → pip → npx → which, 10 тулов, 159с)
  вместо остановки. Существующие механизмы не сработали: success-claim чек видит только
  error-сигналы в tool-выводах, consecutive-failures (5) не набрался из-за перемежающихся
  read-успехов, критик при этом галлюцинировал встречные проблемы («snake.html incomplete» —
  игра на деле работает).
- **Где проявилось:** живой прогон 5 задач через `mma web`, сессия `ses_mul5pepu_9mdq90`
  (песочница `%TEMP%\mma-web-qwen\sandbox`), задачи 3 (FizzBuzz) и 5 (drawio).
- **Реакция harness (ветка `fix/honest-verify-stop-retry`):**
  1. Honest-stop стрика: `consecutiveFailedBatches` (только полностью провальные пакеты;
     успехи/смешанные пакеты сбрасывают, plugin-блоки нейтральны) → директива
     `exec.honest_stop` на 4-м («остановись и ответь честно, вывод не выдумывай») →
     жёсткий стоп `retryLoopStopped` (success:false) на 6-м.
  2. Проверка заявлений: `checkXmlWellFormed` (без зависимостей) заведён в
     `preValidateSyntax` (.xml/.drawio/.svg/.xaml/.plist/.iml); `artifact-claim.ts`
     (файл заявлен как создан/валиден, но отсутствует или не парсится) и
  output-provenance (`checkUnverifiedOutput`: вывод подан как результат запуска,
  но успешных exec-тулов нет) заведены в hallucination-gate с раздельным bounded
  retry-бюджетом на класс (fail-open; общий бюджет давал просачивание: success-retry
  съедал проверку несуществующего `fizzbuzz_output.txt`).
- **Статус:** fixed (тесты: `tool-batch-honest-stop`, `hallucination-artifact-claim`,
  `agent-artifact-resolve`, `agent-claim-check`, `syntax-validator` XML-блок; полный
  сьют 2812 pass).
- **Живая проверка фикса (2026-09-28, сессия `ses_mul8f0t6_zybvp3`, тот же стенд):**
  honest-stop сработала (`Consecutive failed tool batches: 4`), модель перестала
  перебирать варианты и сделала рабочую JS-альтернативу с РЕАЛЬНЫМ запуском
  (`bun fizzbuzz.js` ✓); drawio переписан валидным с первого раза (4 сущности, 3 связи,
  `checkXmlWellFormed` null). Ход завершился честным `turn failed` через аудит
  (план-путаница delete-step vs пересозданный файл — отдельный сабсистемный вопрос),
  а не ложным «ok».
