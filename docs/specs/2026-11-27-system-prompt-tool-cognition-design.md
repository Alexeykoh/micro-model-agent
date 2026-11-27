# Системный промпт: исполняемая схема vs знание, стратегия и бюджет для 9B

**Дата:** 2026-11-27 · **Ветка:** `docs/system-prompt-mechanism` (от `dev`) · **Статус:** W0 принято, дальше — по волнам
**Задача:** FRW4AG · **Наследие:** 2MVWGL, 8VJYKE · **Опора:** [system prompt v3](./2026-10-31-system-prompt-v3-design.md), [startup context](./2026-11-26-startup-context-prompt-design.md), [architecture v2](./2026-10-12-architecture-v2-design.md)

## 1. Диагноз: не объём, а смешение двух планов

### 1.1 Свидетельства живых прогонов (ornith-1.5-9b, окно 131072)

| Сессия | Схема / всего | toolTokens | systemTokens | promptTokens | Поведение модели |
|---|---:|---:|---:|---:|---|
| `ses_mwxuxlky_mirofejjgsgagqde` | 43 / 55 | 10 657 | 1 912 | 14 114 | рассуждает про `web_fetch`/`bash` как про доступные; 3 неудачных вызова подряд |
| `ses_mwz7c4g4_clwgssgjmknukfsn` | 15 / 55 | 3 127 | 1 655 | 5 495 | называет скрытые тулы «своими», считает ~35 и 55 «отдельных инструментов» |
| `ses_mwz8ov32_tcjuionfdnhmklba` | 15 / 55 | 3 127 | 1 819 | 5 710 | счёт верный (15 активных / 40 скрытых / 55 всего), но скрытые снова подаются в списке «которыми я владею» |

Сужение 2MVWGL сработало: 43 → 15 схем, toolTokens 10657 → 3127 (−71%), promptTokens 20569 → ~5710. После этого **симптом сохранился**: модель правильно называет числа, но не различает «могу вызвать» и «знаю о существовании». Значит дефект не в размере схемы, а в механизме промпта.

### 1.2 Фактический текст, который видит модель

Блок `core: hidden tools` в `ses_mwz8ov32` (374 токена):

```
Additional tools — 15 active, 40 hidden (55 total). Names below are NOT in your tool list:
do not call them and do not describe them as available. To use one, call enable_tools with
its tag; its schema appears from the NEXT turn. Example: need web_search →
enable_tools ["web"] → next turn call web_search. If asked how many tools you have:
55 total, 15 active, 40 hidden; count each name once — bracketed tags
are enable paths, not separate tools.
- append_file [file-advanced]
- attach_image [vision, image]
… 40 имён …
```

Отрицание в заголовке проигрывает у списка из 40 конкретных имён: для 9B список — это доминирующий паттерн «Инструменты, которые у меня есть». Один worked example покрывает только путь `enable_tools`, но не ответ на вопрос «что ты умеешь?» — модель достраивает его по списку. Это ровно тот случай, когда скилл `karpathy-system-prompt-learning` называет отсутствующими слоями **worked examples** и **strategy** (exposition есть, но она сведена к отрицанию).

### 1.3 Structural causes

1. **Два плана не разделены.** Исполняемый план — `tools[]` JSON-схемы из `executor.getToolDefinitions` (`src/tools/executor.ts:234-259`); план знания — текст системного промпта. Сейчас один и тот же тул описан в трёх местах: проза ядра (`src/core/system-prompt-render.ts:89-90` — `call web_search/web_fetch`), описание тула и hidden-каталог (`src/tools/hidden-tools-block.ts:35-71`). Нет гейта «имя в тексте ⇔ имя в схеме или в каталоге с путём включения».
2. **Правила самоотчёта нет.** Есть формула счёта, но нет образца ответа и нет правила «активные = только схемы». В скилле `prompt-engineering-patterns` это сочетание Structured Output + Few-Shot: нужна форма ответа, а не число.
3. **Счётчики не согласованы с исполнением.** `hidden-tools-block.ts:38-46` считает видимость как `alwaysOn ∪ activeTags`, а реальная схема проходит ещё через `filterToolsWithOverrides` (`src/tools/filter-tools.ts:25-38`) и `filterDisabledTools` (`src/core/agent/tool-visibility.ts:12-21`). Web UI может включить тул без тега или выключить `alwaysOn` — заголовок «N active» тогда расходится со схемой. При `toolAllowlist` (`executor.ts:249-259`) теги игнорируются при выборе схемы, но всё равно применяются при исполнении (`executor-reject.ts:24-31,58`).
4. **Блок может исчезнуть.** `prompt-assembler.ts:59-67` ставит hidden-блок `priority:"low"`, `essential:false`; при нехватке бюджета `PromptBuilder` (`src/core/prompt-builder.ts:172-220`) выбрасывает его — модель теряет единственный каталог и путь восстановления.
5. **`enable_tools` принимает любые теги.** `src/tools/enable-tools.ts:32-55` не сверяет их с реестром: `enable_tools(["foo"])` отвечает успехом, схема не меняется. Плюс `KNOWN_TOOL_TAGS` (`src/tools/auto-tags.ts:24-36`) не знает `file-advanced`, `agents`, `meta`, `plugin:*`, поэтому preseed не может открыть эти группы, хотя `enable_tools` их обещает.
6. **Две разные оценки tool-токенов.** Каноническая — сумма `estimateTokens(description + JSON.stringify(parameters))` (`iteration-prologue.ts:101-105`); вторая — `estimateTokens(promptSnapshot.tools)` в `context.diff` (`prefix-monitor.ts:43-50`). Hidden-блок уже внутри `systemTokens` и одновременно в `blocks[].tokens` (`prompt-assembler.ts:66`) — суммирование даёт двойной счёт.
7. **Гейд калибровки.** `tests/core/default-tool-budget.test.ts:43` ограничивает 3000 токенов на синтетическом наборе, а живой прогон даёт 3127/3129. Порог и живая метрика разные; в задаче не поднимаем порог «заодно», а фиксируем расхождение как метрику наблюдения.

### 1.8 Расхождение версии (сверка по отдельному пункту задачи)

`session_start.mmaVersion = 0.26.1` в `ses_mwxuxlky` — **не причина** раздутия тулов. Причины:

- `readMmaVersion()` (`src/core/version.ts:7-26`) читает `package.json` относительно исполняемого модуля; `~/.mma/current` указывал на `versions/0.26.1`, пока dev уже был `0.26.2`.
- `session_start` пишется один раз (`src/core/session-log-io.ts:28-37`, `src/core/session-logger.ts:250-254`); второй bootstrap того же файла в 15:34:37Z уже был 0.26.2, но дедуп не обновил запись.
- Внутри одной записи `session-start.ts:76-82` перезаписывает только `environment.provider`, поэтому в логе «heretic/131072 при mmaVersion 0.26.1».

Вывод: это эффект «первый писатель побеждает», а не дефект промпта. В этой задаче **фиксируем диагноз в спеку, код не трогаем** (отдельный контракт сессий/версионирования).

## 2. Границы

**Входит:** разделение исполняемой схемы и каталога знаний; exposition/worked examples/strategy для ответов про инструменты; согласование счётчиков с overrides/disabled/allowlist; контракт `enable_tools`; наблюдаемость реально отправленного запроса; бюджет и приоритеты динамических блоков; гейты и живые проверки на 9B.

**Не входит:** CHANGELOG (правило 10 AGENTS.md), релиз и бамп версии, переписывание всего ядра, смена политики безопасности, изменения формата `AGENTS.md`, содержимое скиллов, новая модель/провайдер, правка `session_start.mmaVersion`.

**Контракты, которые меняются и покрываются этой спекой:**

- `session.jsonl`, событие `llm_request`: добавляются необязательные поля схемы тулов (см. §5);
- `session.jsonl`, событие `context`: поле `blocks` заполняется не только на старте;
- `enable_tools`: отказ на неизвестные теги с actionable-сообщением.

Новых ключей конфига нет: режим остаётся `tools.defaultTags` + `tools.enableOnDemand`, откат — `promptProfile:"large"` / `enableOnDemand:false`.

## 3. Целевая модель промпта

### 3.1 Два плана, один источник правды

| План | Где живёт | Считается как | Правило для модели |
|---|---|---|---|
| **Исполняемый** | `tools[]` JSON-схемы запроса | `executor.getToolDefinitions` → `filterDisabledTools` → `filterToolsWithOverrides` | «Только эти схемы можно вызвать сейчас» |
| **Знание** | системный промпт, каталог по тегам | `registry.getAll()` минус видимые; минус disabled/overrides | «Это справочник возможностей, не доступные функции» |

Имена и счётчики в ответе модели берутся **только из исполняемого плана**. Каталог может называть те же имена, но всегда с пометкой «заблокировано → enable_tools <tag>».

### 3.2 Три слоя (system prompt learning)

**Exposition (что нужно знать):** одно различие — JSON-схемы = вызовы, каталог = знания; определения active/hidden/locked; где находится путь включения.

**Worked examples (2 сценария, формат `INPUT → decision → OUTPUT`):**

1. `INPUT: "какие инструменты у тебя есть?"` → decision: посчитать только схемы → `OUTPUT: "Сейчас доступно 15 схем (файлы, код, bash, git, …); ещё 40 можно включить через enable_tools (web, shell, research, …). Не называю заблокированные имена активными."`
2. `INPUT: "найди погоду в Москве"` → decision: `web_search` есть в каталоге под тегом `web`, схемы нет → `enable_tools ["web"]` → на следующей итерации `web_search` → ответ по фактам страницы.

**Strategy (IF/THEN/BECAUSE):**

- IF пользователь спрашивает про инструменты → THEN считать только схемы и различать active / on-request → BECAUSE каталог — не разрешение на вызов.
- IF нужная возможность есть в каталоге → THEN вызвать `enable_tools` с её тегом сейчас → BECAUSE схема появится только со следующей итерации (внутри того же хода).
- IF просят вызвать имя из каталога → THEN сказать «сейчас заблокирован, включаю через enable_tools» → BECAUSE иначе модель притворяется, что владеет тулом.
- IF тул выключен через overrides/disabled → THEN считать его locked, а не active → BECAUSE счёт должен совпадать со схемой.
- IF пользователю показываем инструмент → THEN использовать `tool.friendly.*` (STYLE.md:20) → BECAUSE системные имена не показываются в UI.

### 3.3 Структура и стабильность

- Блок `core: tool contract` — `essential: true`, ≤180 токенов, в стабильном префиксе до волатильных блоков: exposition + strategy + оба worked example в компактной форме.
- Блок `core: tool catalog` — `priority:"low"`, `essential:false`, ≤400 токенов, имена сгруппированы по тегам; при нехватке бюджета выбрасывается **весь**, но contract остаётся.
- Внутри хода system заморожен (`frozenMapBlock`, `system-prompt-freeze.test.ts`); `enable_tools` меняет схему на следующей итерации, а не текст текущего system.
- Модельный текст — английский (спека v3 §8); пользовательские строки — через `t()`.

## 4. Инвентаризация блоков и бюджет (база: `ses_mwz8ov32`, старт)

| Блок | Источник | priority / essential | Токены |
|---|---|---|---:|
| `core: system` | `system-prompt-render.ts:54-238` | critical / да | 1030 (907 без security; потолок гейта 910) |
| `mcp` | `modules/mcp/tool-shape.ts:67-104` | high / нет | 20 |
| `core: plan reminder` | `bootstrap/modules-prompt.ts:66-74` | high / нет | 50 |
| `core: model` | `system-prompt.ts:31-43` | normal / нет | 26 |
| `skills: skills catalog` | `modules/skills/catalog.ts:38-64` | normal / нет | 95 |
| `indexer: project map (stub)` | `modules/indexer/map-info.ts:38-51` | normal / нет | 44 |
| `session` | `modules/session/module.ts:17-30` | low / нет | 30 |
| `plugins: [PLUGIN CAPABILITIES]` | `plugins/capabilities-block.ts:34-55` | low / нет | 127 |
| `core: hidden tools` | `tools/hidden-tools-block.ts:35-71` | low / нет | 374 |
| **Итого systemTokens** | | | **1819** |
| JSON-схемы 15 тулов | `iteration-prologue.ts:94-105` | отдельный план | **3127** |

Не участвуют в стартовом промпте, но конкурируют за бюджет на ходу: `skills: loaded skills` (cap 6000, `tail`), AGENTS.md root (~6100 в репо-примере, `essential`), вложенные AGENTS.md, LSP health-check, plugin `onBuildPrompt`, `overflow note` (резерв 60), `omitted blocks` (до 5). Бюджет — `contextBudget.systemPrompt = 0.1` (3276 на 32K), четыре места вычисления (`prompt-phase.ts:91`, `modules-prompt.ts:127`, `prompt-info.ts:27`, `manager-state.ts:160-176`) — кандидат на единый `resolveSystemBudget`.

## 5. Метрики, база и цели

| Метрика | База (`ses_mwz8ov32`) | Цель | Источник / гейт |
|---|---:|---:|---|
| Видимых тулов при дефолте | 15 / 55 | ≤16, скрытые доступны по тегам | `tests/core/default-tool-budget.test.ts:34-96` |
| toolTokens старта | 3127 (guard: ≤3000 на синтет. наборе) | ≤3300 в живом прогоне; расхождение гейда зафиксировать | `context` event; `default-tool-budget.test.ts:43` |
| systemTokens старта | 1819 | ≤1950 | `context` event, `prompt-info.ts:35-72` |
| `tool contract + catalog` | 374 (один hidden-блок) | ≤580 суммарно (≤180 + ≤400) | `blocks[].tokens`, snapshot-тест |
| promptTokens первой итерации | 5710 | ≤6100 (+7% максимум) | `llm_usage` (`origin:"api"`) |
| Корректность ответов о тулах | 0/3 живых ответа | 3/3 в живом прогоне (3 зонд-вопроса) | `session.jsonl`, ручная разметка ответов |
| `enable_tools` по web-запросу | не проверено | правильный тег с первого вызова, ≤1 лишней итерации | `tool_defs`/`llm_request` до и после вызова |
| Наблюдаемость запроса | `llm_request` только с webui-мостом, без JSON-схем | снимок в CLI + `parametersSha256` по каждому тулу | `llm_request`, `tests/llm/request-snapshot.test.ts` |
| Расхождение версии | 0.26.1 в `session_start` при dev 0.26.2 | диагноз зафиксирован, код не меняется | §1.8 |

## 6. Контрактные изменения

1. **`llm_request.tools[]`** — необязательные поля `parametersSha256?: string` (16 hex от `JSON.stringify(parameters)`) и `parametersChars?: number`. Сейчас `SnapshotTool` хранит только `name` и усечённое `description` (`src/llm/request-snapshot.ts:44-49,205-225`), и тест это фиксирует (`:57`). Это позволяет доказать, какая схема реально ушла, не раздувая журнал.
2. **`context.blocks`** — заполнять на каждой итерации, а не только на старте (`prompt-info.ts:56-72` пока пишет `systemTokens` только на `start`). Поле уже определено, новый ключ не вводится.
3. **`enable_tools`** — неизвестный тег → `success:false` + сообщение со списком допустимых тегов из реестра; успешный выход дополнительно несёт `activeTags` и `nowVisible` (уже есть). i18n `en`/`ru` — симметрично.
4. **Публикация `llm_request` в CLI** — через `SessionLogger.logLlmRequest()` рядом с `logLlmUsage()` (`src/core/session-logger.ts:194-196`), webui-мост оставить только для SSE. `source:"core"` обязателен (INV-13, `tests/arch/session-provenance.test.ts`).

## 7. План волн

Каждая волна — отдельный коммит, `bun test` + `bun run quality` зелёные до мержа в `dev`.

- **W0 — спека и падающие гварды (этот документ).** Фиксируем метрики §5 и тесты, которые падают на текущем поведении: счёт hidden-блока при override/disabled, ответ «я владею скрытыми», параметры схемы в `llm_request`, неизвестный тег `enable_tools`.
- **W1 — tool cognition.** Разделить `core: tool contract` (exposition + strategy + 2 worked example) и `core: tool catalog`; убрать формулировку «Names below are NOT in your tool list» и заменить её на «catalog, not callable»; сгруппировать имена по тегам; golden snapshot и phrase-guard; проверить, что примеры не содержат имени вне схемы/каталога.
- **W2 — контракт `enable_tools` и честные счётчики.** Валидация тегов; hidden-блок считает visible через тот же селектор, что и схема (`filterToolsWithOverrides` + `filterDisabledTools`); устранить рассинхрон allowlist↔enforcement; отдельно — расхождение массивов тегов у субагента (`subagent-run.ts:175-189` vs `executor.ts:57-76`).
- **W3 — наблюдаемость.** `parametersSha256`/`parametersChars` в `llm_request`, `context.blocks` на каждой итерации, снимок в CLI без webui. Гарантировать, что по логу можно восстановить system + names + схему тулов.
- **W4 — бюджет и приоритеты.** Единый `resolveSystemBudget`; hidden/contract блоки получают явный приоритет (contract essential, catalog low); инструментальный бюджет учитывается вместе с system в стартовом гейте; починить `system-prompt-line-length.test.ts` (читает баррель вместо `system-prompt-render.ts`); общий `overflow-note` вместо двух механизмов деградации.
- **W5 — живые проверки и интеграция.** 9B-прогон с изолированным `MMA_CONFIG_DIR`, три зонд-вопроса про тулы, web-запрос на `enable_tools`, замер метрик §5; `bun test` + `bun run quality`; мерж в `dev`; отметки чеклиста FRW4AG.

## 8. Риски и открытые вопросы

1. Если 9B всё равно принимает каталог за доступные инструменты — одобрить fallback: убрать имена из каталога, оставить только «capability → tag» и требовать `enable_tools` по названию возможности. Решение — по живому прогону W5, а не по соображениям экономии токенов.
2. +~200 токенов system против −71% toolTokens — допустимо, если `promptTokens` ≤6100. Иначе ужать catalog до tags-only.
3. Preseed остаётся аддитивным; ложные срабатывания `WEB_RE`/`DOCUMENT_RE` (`auto-tags.ts:41-64`) не исправляются «заодно» — отдельная метрика и, при подтверждении, отдельная волна.
4. Валидация тегов `enable_tools` может сломать плагинные теги `plugin:<name>` — accepted-множество строить из реестра, а не из `KNOWN_TOOL_TAGS`.
5. Версию в `session_start` не трогаем: это отдельный контракт сессий.

## 9. Находки по промптам (разбор со скиллами)

Разбор сделан по трём рамкам: `karpathy-system-prompt-learning` (exposition / worked examples / strategy), `prompt-engineering-patterns` (system prompt design, few-shot, structured output, progressive disclosure, token efficiency) и `mma-development` (правило «одна правда», гейты, stream/line-length). Ниже — конкретные дефекты, а не общие пожелания.

### 9.1 Системный промпт (`buildSystemInfo` и динамические блоки)

| # | Находка | Доказательство | Принцип / гейт | Волна |
|---:|---|---|---|---|
| 1 | Промпт обещает тулы, которых нет в схеме: `LIVE DATA … call web_search/web_fetch first`, а у этих тулов теги `["web","research"]` и при `defaultTags=[file,code]` их в `tools[]` нет | `src/core/system-prompt-render.ts:89-90`, `src/config/defaults.ts:61`, `src/tools/web-search.ts:154` | «Промпт не обещает того, чего не делает» (v3 §2.3); `guidance-enforcement.test.ts` проверяет только bash-операторы | W1/W4 |
| 2 | Три противоречащих правила про `list_dir`: «не осматривайся через list_dir», «при not found — list_dir рабочую папку и родителя», «SESSION START: list_dir (package.json/tests/config)». Для 9B оговорка «named path» не снимает противоречие | `system-prompt-render.ts:87,91,107` | Одно правило вместо трёх; semantic-guard вместо substring | W4 |
| 3 | Политика безопасности продублирована в прозе и в описании `bash`; в прозе перечислено подмножество операторов `(| > >> ; &&)`, а валидатор знает ещё `||`, `&`, backtick, `$()` | `system-prompt-render.ts:197-226`, `bash-description.ts:12-15`, `guidance-enforcement.test.ts:27-34` | Single source of truth; гейт не проверяет prose-текст | W4 |
| 4 | Счёт с многократными попытками дан в трёх формулировках (3 batch / 3rd time / 2+ approaches); константы из v3 §7.12–13 не заведены | `system-prompt-render.ts:112,114,120`, `docs/specs/2026-10-31-system-prompt-v3-design.md:252-253` | Одна константа = одно упоминание | W4 |
| 5 | Plan reminder учит «проверить `plan show` … enable_tools core», но сам plan-блок удалён из сборки; состояние плана живёт только в `<system-summary>` | `bootstrap/modules-prompt.ts:66-74` vs `bootstrap/modules-phase.ts:96-98` | Текст описывает несуществующее состояние схемы | W4 |
| 6 | Workflow браузера продублирован в двух канонах; важное ограничение «не использовать для поиска (CAPTCHA/429)» есть только в описании тула, а в блоке модуля его нет | `modules/browser/module.ts:33-37` vs `tools/browser.ts:96-104` | Два канона одного правила | W1/W4 |
| 7 | Модельный текст не однороден: ядро EN, а LSP health-check строит заголовок через `t()` → локаль пользователя меняет системный промпт | `modules/lsp/startup-check.ts:62`, v3 §8 | «Модельный текст — английский» | W4 |
| 8 | Ядро 907 токенов при потолке гейта 910; вариант с security (~996) вообще не покрыт снимком, потому что тест выключает security | `tests/core/system-prompt-compact.test.ts:25-41` | Нет места под новые директивы → нужны отдельные блоки с бюджетом, а не дописывание ядра | W1/W4 |
| 9 | Hidden-каталог: отрицание в заголовке + 40 имён; blocked/active считается без overrides/disabled, блок `priority:low, essential:false` и может быть выброшен | `tools/hidden-tools-block.ts:9-71`, `core/prompt-assembler.ts:59-67` | См. §1.2, §3 | W1/W2 |

### 9.2 Промпты инструментов (description и контракты)

| # | Находка | Доказательство | Волна |
|---:|---|---|---|
| 1 | `write_file` в своём описании советует `enable_tools file-advanced` — путь лежит вне его схемы; модель тратит итерацию на включение, хотя гейт не проверяет такие упоминания | `tools/write-file.ts:41-44` | W2 |
| 2 | `subagent` советует `enable_tools agents`, но `KNOWN_TOOL_TAGS` не содержит `agents` — preseed не может открыть группу, которую тул рекламирует | `tools/subagent.ts:13-14`, `tools/auto-tags.ts:24-36` | W2 |
| 3 | `bash` обещает «process tools … enable_tools shell»; счётчики hidden-блока при этом не учитывают, что `process_*` реально включены через override | `tools/bash-description.ts:3-10`, `tools/hidden-tools-block.ts:38-46` | W2 |
| 4 | `define_capability` → `enable_tools meta`, `load_skill` → `enable_tools core`, capabilities-блок → `enable_tools meta`: один и тот же паттерн размножен по четырём файлам без единого реестра путей | `tools/define-capability.ts:81`, `tools/load-skill.ts:55`, `modules/plugins/capabilities-block.ts:43` | W2 |
| 5 | `enable_tools` отвечает `success:true` на любой тег, включая несуществующий: схема не меняется, но модель получает ложное подтверждение «Enabled tool tags: foo» | `tools/enable-tools.ts:32-55` | W2 |
| 6 | Эвристики preseed имеют ложные срабатывания (`цен`, `курс`, `стать`, `документ` → `web`; любой `.json`/`.md` → `document`) и не знают `file-advanced`/`agents`/`meta`/`plugin:*`; теги аддитивны и не откатываются | `tools/auto-tags.ts:41-64,102-112` | W2 (метрика), отдельная волна при подтверждении |
| 7 | Селектор схемы (`executor`) и исполнение (`executor-reject`) расходятся при `toolAllowlist`; у субагента схема читает свой массив тегов, а enforcement — родительский | `tools/executor.ts:234-259`, `tools/executor-reject.ts:24-31,58`, `tools/subagent-run.ts:175-189` | W2 |
| 8 | Наблюдаемость: `tool_defs` логирует набор до фильтров, `llm_request` хранит только имена/описания и только при webui-мосте; `system event` ≠ реально отправленный system | `core/agent/iteration-prologue.ts:178-182`, `llm/request-snapshot.ts:44-49,205-225`, `modules/webui/session/request-forward.ts:26-43` | W3 |

### 9.3 Что дала рамка трёх слоёв

| Слой | Состояние сейчас | Разрыв |
|---|---|---|
| Exposition | Есть как список «делай/не делай» (~907 токенов) | Нет концепции «схемы = вызовы, текст = знание»; модель не понимает разницу между планами |
| Worked examples | Один пример: `enable_tools ["web"] → web_search` | Нет образца ответа про свои инструменты, read-only и not-found; сценарии для 9B почти отсутствуют |
| Strategy | Правила размазаны по ядру, описаниям тулов, hidden-блоку и модулям | Нет явных IF/THEN/BECAUSE, нет чек-листа проверки перед ответом; числа противоречат друг другу |

Дополнительно по `prompt-engineering-patterns`: progressive disclosure нарушен (40 имён upfront вместо «возможность → тег»), structured output для самоотчёта отсутствует, а token efficiency страдает от дублирования одного правила в 3–4 местах — при этом экономия достигается не укорачиванием текста, а устранением дублей и переводом деталей в описания тулов.

## 10. Ссылки

- Код: `src/core/system-prompt-render.ts`, `src/core/prompt-assembler.ts`, `src/core/prompt-builder.ts`, `src/tools/hidden-tools-block.ts`, `src/tools/enable-tools.ts`, `src/tools/auto-tags.ts`, `src/tools/executor.ts`, `src/llm/request-snapshot.ts`, `src/core/agent/prompt-info.ts`.
- Тесты: `tests/core/default-tool-budget.test.ts`, `tests/core/system-prompt-compact.test.ts`, `tests/core/system-prompt-freeze.test.ts`, `tests/llm/request-snapshot.test.ts`, `tests/tools-tags.test.ts`, `tests/arch/guidance-enforcement.test.ts`.
- Спеки: [system prompt v3](./2026-10-31-system-prompt-v3-design.md), [startup context](./2026-11-26-startup-context-prompt-design.md), [architecture v2](./2026-10-12-architecture-v2-design.md).
- Правила: `AGENTS.md` (правила 2, 3, 5, 7, 10), `docs/design/ui/STYLE.md:20`.
