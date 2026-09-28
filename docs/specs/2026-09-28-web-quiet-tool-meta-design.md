# Web quiet: прятать model-facing тела тулов из ленты (question/plan/diff)

Дата: 2026-09-28
Статус: draft
Ветка: `feat/web-quiet-tool-meta`

## 1. Проблема и цель

В web-ленте (`mma web`) при дефолтном `quiet` видны сырые тела тулов, которые
ничего не говорят пользователю (скрины 2026-09-28, сессия «Подбор велосипеда MTB»):

- `question` — dim-абзац `Пользователь ответил на ваши вопросы: "...". Теперь
  продолжайте... Ответы живут только в этой сессии... Заданы первые 3 из 4...
  вызовите тул ещё раз` — директива модели, ответ уже показан в блоке вопроса (`↳ ...`).
  После коммита `259e980` (memory-aware question) стало только длиннее:
  `answered + memory_known + session_only + batch_truncated` склеены в один `output`.
- `plan create/update` — `[plan_h2dsev]`, `Dir:`, `Created:`, `Progress: 1/5 done`,
  `[x]/[ ]`, `архивирован... создай новый план... нельзя проверить автоматически...
  запусти сборку/тесты` — внутренние id/пути/инструкции модели.
- `write_file` — простыня диффа `1 + # ...` на ~30 строк.

**Цель:** в `quiet` (дефолт) web-лента показывает одну строку на действие
(как терминал), а model-facing тела — нет. Детали остаются за
`/verbose`/`verbose` (паритет с `STYLE.md`: quiet by default).

## 2. Корень (факт, проверен по коду)

- `src/core/agent/tool-batch.ts:196-223` — success-`output`, `display` и `diff`
  идут через `onMeta()`. Ошибки — свернутый gist (там же).
- Терминал `src/ui/renderer.ts:349-352` (`writeInlineBody`) в `quiet` тела глотает
  (первая строка сохраняется для ошибок/`Ctrl+O`) — поэтому в REPL тихо.
- Web `src/modules/webui/forward.ts:137-140` везёт `meta` отдельным SSE без типа,
  а `feed.js:251-261 onMeta` рисует **всегда**, без проверки `verbosity()`
  (проверка есть только в `onToolEnd:404-418`). Утечка — только через `onMeta`.
- Структурные карточки уже есть и не требуют сырья: план — отдельное SSE `plan`
  (`run-agent.ts:89-90`, `feed.js:685 onPlan`); файл — `cardFor` + `open`;
  ответ на вопрос — `↳` в блоке вопроса (`makeQuestionBlock`).

## 3. Non-goals

- Не меняем терминальный REPL (там уже тихо; сигнатура обратно совместима).
- Не меняем тексты `output` тулов (модели нужен полный текст) — режем только UI-путь.
- Не трогаем `verbose`/`normal`: там детали уже обещаны; дедуп `onMeta`+`toolout`
  в non-quiet и чистка директив в verbose — follow-up, не этот спек.
- Новых SSE-событий/эндпоинтов нет — только опциональное поле `kind` у `meta`.

## 4. UX (quiet, web)

| Тул | Было | Станет |
| --- | --- | --- |
| `question` | строка `◇ Вопрос … ✓` + dim-абзац директив | только строка + блок вопроса с `↳ ответ` |
| `plan` | строка + сырой `display/output` | только строка + структурная `plan`-карточка |
| `write_file`/`edit_file` | строка + `Записан…` + дифф-простыня | строка + файл-карточка (`open`); дифф скрыт |
| упавший тул | `↳ причина` via `tool_end` (+ возможный дубль gist via `meta`) | один `↳ причина` via `tool_end`; дубль gist подавлен |
| статусы (контекст, компакция, hallucination-warn, MoE-verbose) | dim-строки | без изменений, всегда видны |

## 5. Решение

1. **Помеченный `meta`-канал.** `onMeta(chunk, kind?: "tool" | "status")`
   (второй параметр опционален — все текущие вызывающие стороны работают без правок).
   `ToolBatch` помечает свои 4 вызова (`display`, success-`output`, failure-gist,
   `diff`) как `kind="tool"`; остальные (`context-renderer`, `hallucination-gate`,
   `agent-moe`) — по умолчанию `status`.
2. **Проброс.** `forward.ts onMeta(chunk, kind)` кладёт `kind` в SSE `meta`
   (только когда задан, wire обратно совместим); `feed.js onMeta` дропает
   `kind === "tool"` при `verbosity() === "quiet"`.
3. **`question`: `display: ""`.** `tool-batch.ts:196-199`: `display !== undefined`
   выбирается вместо `output`, пустой — не шлётся вообще. Модель по-прежнему
   получает полный `output` в `role:"tool"`; UI не дублирует блок вопроса ни на
   одной verbosity (ответ уже в `↳`). Меняется только возврат тула + 1-2 теста.
4. Терминал: `renderer.meta` принимает и игнорирует `kind` (гейтинг там уже есть
   через состояние карточки) — поведение не меняется, `Ctrl+O` цел.

Альтернатива (отклонена): гейтить в `tool-batch` по `config.ui.verbosity` на
отправке — сломала бы терминальный `Ctrl+O` (тела хранятся из того же `onMeta`)
и продублировала бы уже существующий render-time гейтинг.

## 6. Затронутые файлы (ожидаемо)

- `src/core/types.ts` — тип `onMeta` (+ `MetaKind`).
- `src/core/agent/tool-batch.ts` — 4 вызова с `kind="tool"`.
- `src/modules/webui/forward.ts` — `onMeta(chunk, kind?)` → SSE `kind`.
- `src/modules/webui/state.ts` — тип `SseEvent meta` (+ `kind?`).
- `src/modules/webui/assets/js/feed.js` — гейтинг в `onMeta`.
- `src/tools/question.ts` — `display: ""` во всех success-возвратах.
- Тесты: `tests/tools/question.test.ts` (display), новый/расширенный тест
  проброса `kind` (forward) + гейтинга (feed/jsdom или e2e по наличию инфры).
- `CHANGELOG.md` — запись в Unreleased/Fixed.

## 7. i18n

Новых строк нет. `display: ""` не локализуется.

## 8. Тесты и приёмка

- `bun test` + `tsc --noEmit` зелёные (гейт ветки по AGENTS.md).
- Ручная приёмка в `mma web` (quiet): вопрос из 3+ пунктов, `plan create/update`,
  `write_file` нового файла — в ленте нет dim-абзацев сырья/диффов; план-карточка,
  файл-карточка и `↳` ответов на месте; упавший тул — один `↳`; `verbose` —
  тела на месте.
- E2E web — только по явной команде (медленно), по умолчанию — unit/jsdom.

## 9. Риски

- Сторонние `plugin runOnMeta` оборачивают текст, но не `kind` — тул-тела,
  прошедшие через плагин, сохраняют `kind` (метка ставится вызывающей стороной,
  не содержимым).
- `question display:""` — web `tool_end` в `verbose` покажет полный `output`
  (директивы) через `renderToolOutput`: осознанно, это non-quiet follow-up.
