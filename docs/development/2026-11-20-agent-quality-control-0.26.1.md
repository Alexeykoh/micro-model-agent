# Журнал разработки: улучшение управления агентом (0.26.1)

**Ветка:** `feat/agent-quality-control` · **База:** `dev` @ `0.26.1`
**Спека:** [2026-11-20-agent-quality-control-design.md](../specs/2026-11-20-agent-quality-control-design.md)
**Цель:** поднять качество управления моделью по итогам сессий `ses_mwor4q49`,
`ses_mwon4u7o`.

## 1. Базовый замер (до правок)

Записывается до изменения кода. Источники: полный прогон `bun test`, `bun run quality`,
а также воспроизводимые проверки восьми дефектов (тесты добавляются в этой ветке и
должны падать на базовой версии).

| Метрика | Значение до правок | Источник |
|---------|--------------------|----------|
| `bun test` | **6950 pass / 16 skip / 1 fail**, 6967 тестов в 973 файлах, 362.93 c | лог `mma-baseline-test.log` |
| Единственный базовый fail | `tests/cli/repl-plan.test.ts` → «read-only CLI: сессия не создаётся > `plugins list` оставляет каталог sessions пустым» (5101.68 ms) | тот же лог; к правкам агента отношения не имеет |
| `bun run quality` | _заполняется после прогона_ | лог `mma-baseline-quality.log` |

> Оговорка: прогон `bun test` был запущен **до** первой правки, но первые изменения кода
> внесены, пока он ещё шёл (363 c). Результат используется как отправная точка с оговоркой;
> финальное сравнение делается по повторному прогону на полностью изменённом дереве.
| AQC-1: пропущенный `evidence` требует behavioral | падает | `tests/execution/verify-evidence-class.test.ts` |
| AQC-2: `done` без хэша | падает | `tests/execution-plan-file-modified.test.ts` |
| AQC-3: degraded critic + check | падает | `tests/modules/critic/critic-degraded-gate.test.ts` |
| AQC-4: подмена результата тула | падает | `tests/core/tool-result-rewrite.test.ts` |
| AQC-5: ранняя компакция ≤64K | падает | `tests/core/compaction-early-small.test.ts` |
| AQC-6: `patch_file` + валидация `append_file` | падает | `tests/tools/patch-file.test.ts` |
| AQC-7: failover на `socket closed` | падает | `tests/providers-fallback.test.ts` |
| AQC-8: actionable-сообщения + уборка процессов | падает | `tests/tools/enforcement-url.test.ts` |

## 2. Ход работ

| Волна | Правки | Статус | Результат проверки |
|-------|--------|--------|--------------------|
| W1 | AQC-1, AQC-2, AQC-3 | выполнена | `bun test` 5 файлов: 36 pass / 0 fail |
| W2 | AQC-4 | выполнена | `bun test` 3 файла: 17 pass / 0 fail; порог отключения тула 8 → 3, результат подменяется описанием сбоя |
| W3 | AQC-5, AQC-6 | выполнена | `bun test` компакция 2/2 + patch-тул 7/7; компакция ≤60 сообщений, патч 5–20 строк вместо перезаписи |
| W4 | AQC-7, AQC-8 | выполнена | `bun test` 4 файла: 8 pass / 0 fail; transient-сеть, actionable-подсказки, уборка процессов |

## 3. Проверки после правок

| Проверка | Результат |
|----------|-----------|
| `bun run quality` (typecheck, frontend, check:arch, lint, fallow) | **зелёный** (лог `mma-verify-quality.log`) |
| `bun test` полный | 6961 pass / 16 skip / 7 fail; все 7 при изолированном повторе прошли (флейк от параллельной нагрузки), лог `mma-verify-test.log` |
| Totally isolated повтор 7 падавших файлов | 7/7 pass (`tests/execution-typecheck-gate.test.ts`, `tests/attach-image.test.ts`, `tests/bash-docker.test.ts`, `tests/cli/readonly-no-overflow-warning.test.ts`) |
| Arch-гейт `tests/arch/agent-quality-control.test.ts` | 8/8 pass; добавляет контрактные проверки AQC-1…8 |
| Браузерные e2e (до починки) | 16 падений; базовый замер на чистой `dev` в worktree падал так же — устаревшие селекторы/пути ассетов, а не регрессия |
| Браузерные e2e (после ветки `fix/e2e-stale-selectors`) | **12 файлов, 35 passed / 3 skipped**, 566.55 c — лог `mma-e2e-final.log`. Ветка влита в эту; `bun run quality` после merge зелёный |
| Финальный `bun test` после всех правок | **6974 pass / 16 skip / 2 fail**, 6992 тестов в 982 файлах, 383.59 c — лог `mma-final-green-test.log`. Два падения (`attach_image`, `bash-docker`) при изолированном повторе проходят (11/11) — сетевые флейки по 5 c |
| Изменения в `src/modules/webui/assets/**` | **нет** — в ветке не трогались ни вёрстка, ни ассеты, ни селекторы |

### Что было исправлено в процессе проверки

- `kind: "info"` → `"ok"` в диагностике уборки процессов (тип `onDiagnostic`).
- Превышение лимита 300 строк: `turn-run.ts`, `compaction.ts`, `loop-state.ts`,
  `tool-batch-signals.ts` — новые хелперы вынесены в `turn-process-cleanup.ts`
  и `compaction-early.ts`, комментарии сжаты; `.arch-allowlist.json` не трогался.
- `double-honesty`: новый метод `getContextWindow` записан в `UNCOVERED_CONTEXT_METHODS`
  с причиной и ссылкой на тест.
- Каскадные регрессии планов после смены дефолта `evidence`: введён
  `inferDefaultEvidence()` — значение выводится из machine-readable check, а не из
  слов описания (правило №10); UI-файлы получают behavioral, остальное сохраняет
  прежнюю static-семантику.
- Последний отключённый тул остаётся в схеме (`tool-visibility.ts`), иначе модель
  переходит к текстовому ответу и failed-batch терминал не срабатывает.
- Сетевой обрыв: `terminal: true, recoverable: true` — HTTP-слой уже ретраил, но
  агент получает причину обратно вместо «Ошибка LLM».

## 4. Живая проверка на bonsai-2-27b-pq2 (llama.cpp / llama-swap)

Прогон через `mma web` в браузере, 2026-11-20 19:15–19:23 MSK. Изолированный
`MMA_CONFIG_DIR`, сессия `ses_mwp6ft2u_bnkrezboqgkwqvaq`, песочница
`_testing/live-bonsai`, провайдер `llama-local` → `http://127.0.0.1:8080/v1`.
В UI подтвердена версия `mma 0.26.1`.

| Правка | Подтверждение вживую | Источник |
|--------|----------------------|----------|
| AQC-1 | `plan_step` отклонил `file-modified:comp.tsx` как static-доказательство для UI-файла: «the step changes behaviour/UI … Provide behavioural proof» | лента + `session.jsonl` |
| AQC-2 | Два отказа «Cannot mark step N done: its check failed — file-modified:…» без изменения файла | лента + `session.jsonl` |
| AQC-3 | Три срабатывания критика (`concern` / `critical`), две ретракции черновика в ленте | лента |
| AQC-4 | После трёх падений `bash` отключён, модели ушла директива «DISABLED for the rest of this turn» | `session.jsonl`, `16:21:29` |
| AQC-5 | `compaction reason=early-small-model, messages 60→11`, затем вторая компакция на 13-й итерации | `session.jsonl` |
| AQC-6 | Модель сама вызвала `patch_file` (сначала `note.txt`, затем `comp.tsx`), успех + diff | лента + `tool_call`/`tool_result` |
| AQC-7 | **Не воспроизведено**: апстрим не рвал соединение; покрыто только юнит-тестами | — |
| AQC-8 | Блок SSRF пришёл дословно с actionable-советом; фоновый `bun server.js` (порт 8899) убит в конце хода — `tool_degraded: stopped 1 process(es) started during the turn` | `session.jsonl`, `16:19:19` / `16:23:10` |

**Честное наблюдение:** модель пересказала actionable-совет неточно (в финале
появился «start with the same config env…»), хотя в `tool_result` текст был
корректным. Это свойство 27B-модели, не дефект харнесса.

## 4a. Живая проверка `feat/control-precision` (0.26.1)

Сессия `ses_mwp7z1so_twhacjvvecjlrsuo`, `mma web` на `127.0.0.1:7336`,
изолированный конфиг `%TEMP%\opencode\mma-live-precision\config`, модель
`bonsai-2-27b-pq2`. Спека: `docs/superpowers/specs/2026-11-20-agent-control-precision-design.md`.

| Пункт | Статус вживую | Доказательство |
|-------|---------------|----------------|
| BCP-6 (дешёвый критик) | **подтверждено** | `critic_verdict { skipped: "static_fastpath", tools: ["write_file","patch_file"] }`; ответ за 41.7 c без лишнего LLM-критика |
| BCP-5 (coverage по текущему сообщению) | **подтверждено** | Второй запрос в той же сессии создал план с первой попытки; старый `alpha.txt` не вызвал «Plan does not cover files required» |
| BCP-2 (каноничная фраза блокировки) | **подтверждено** | Вjournal ответ содержит дословную `Action: … allowLoopback=true … web_fetch …`; искажения не было, гейт не потребовал переответа |
| BCP-4 (санитизация компакции) | **подтверждено** | Две компакции `early-small-model` (62→11, 60→9 messages); в сводках нет `[Errors:]` и `[Already tried & failed]` |
| BCP-1 (ложный «file missing») | не воспроизведён вживую | Покрыт юнит-тестом `tests/core/control-precision-wave1.test.ts` |
| BCP-3 (мягкий бюджет 16 тулов) | не воспроизведён вживую | Сработал более ранний duplicate/failed-batch терминал; покрыт юнит-тестом |
| BCP-7 (TTL правила памяти) | не воспроизведён вживую | Модель не выполнила bash-сценарий из-за засорённого плана; покрыт юнит-тестом |

Проверки: `bun run quality` зелёный, 101/101 таргетных тестов по трём волнам,
i18n en/ru симметричен. Дополнительный e2e после этой ветки не гонялся — UI не менялся.

## 5. Решения и compromises

- Forced `tool_choice` отклонён: llama.cpp откатывает именованный выбор к `auto`.
- Дедупликация директив оставлена косметикой: текстовые уговоры не лечат цикл.
- `CHANGELOG.md` и версия пакета не трогаются — релиз по отдельной команде.
- E2E-набор чинился отдельной веткой `fix/e2e-stale-selectors` (коммит `7b6b151e`) и
  влит сюда merge: 16 падений оказались устаревшими селекторами под текущий UI
  (компактные табы сайдбара, внутренние табы Agent/Plugins, асинхронный registry
  и presets, скрытый reasoning-ряд, отсутствующий `providerReachable` в моке).
