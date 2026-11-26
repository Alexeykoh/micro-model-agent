# Стартовый контекст: честный лог, явный конфиг, ленивая карта и узкие тулы

**Дата:** 2026-11-26 · **Ветка:** `fix/stale-session-prompt` (от `dev`) · **Статус:** принято к реализации
**Задача:** 8VJYKE · **Источник:** разбор сессии `ses_mwxu5mg2_nxrbxpxslqxhwbso`

## 1. Проблема и диагноз

В сессии `ses_mwxu5mg2_nxrbxpxslqxhwbso` сайдбар показывал 17.6K / 131.1K токенов.
Разбор `session.jsonl` и `web-usage.json` показал, что **старого промпта из другой сессии нет**:

| Часть | Токенов | Источник |
|---|---:|---|
| `system` | 8 245 | блоки: `core: system` 1014, `indexer: Project map` 6177, память 421, скиллы 166, плагины 96, MCP 20, прочее ~350 |
| `tools` | 8 895 | JSON-схемы **всех 54 тулов**, а не текст промпта |
| `history` | 414 | два сообщения |

Три настоящие причины:

1. **Обрезка в логе.** `llm_request.system` режется до 12 000 символов
   (`src/llm/request-snapshot.ts:185`) и содержит `… [truncated from 32405 chars]`;
   `slog.logSystem` пишет только первые 2 000 символов (`src/core/agent/session-start.ts:115`).
   По логу невозможно ответить, какой промпт реально ушёл в модель.
2. **Явный конфиг молча перезаписывается.** `config.core.json` задаёт
   `indexer.mapTokenBudget: 1500`, но `effectiveMapTokenBudget(1500, 1500, 131072, 128000)`
   возвращает 6000: значение, равное дефолту, считается «не заданным»
   (`src/modules/indexer/module.ts:45-53`). Итог — карта 6177 вместо 1500 токенов.
3. **Два autoscaling-правила на окне ≥128K.** L2 поднимает бюджет карты 1500 → 6000;
   L5 делает профиль `large`, из-за чего `enableOnDemand` выключается и `defaultTags`
   игнорируется — в схему уходят все тулы (`src/core/bootstrap/session-phase.ts:196-202`).

Дополнительно: в промпте нет блоков `agents-md` (инструкции проекта не загружены в этой
сессии), но это отдельное наблюдение, в данную спеку не входит.

### Обоснование решений (внешние практики)

- Aider: `--map-tokens` по умолчанию 1024, максимум ~4096; карта ранжируется PageRank по
  графу зависимостей и живёт в **стабильной** части промпта; для слабых моделей repo map
  отключают — они «перегружаются и пытаются править код из карты».
  https://aider.chat/docs/repomap.html · https://aider.chat/docs/faq.html
- Cursor, dynamic context discovery: меньше деталей upfront, агент подтягивает релевантное
  сам. https://cursor.com/blog/dynamic-context-discovery
- Multigrid: ранжировать карту по задаче и не пересобирать её каждый шаг (ложная экономия,
  ломает кеш). https://multigrid.ai/learn/coding-agent-context
- MCP-Zero: активное обнаружение тулов режет промпт на 60–98% и сохраняет точность там, где
  «все схемы сразу» падают с 97.6% до 69.2%; Anthropic рекомендует deferring tool
  definitions; исследование MCP — рост промпта линейно от числа тулов, лимит ~40.
  https://arxiv.org/html/2506.01056v3 · https://arxiv.org/html/2511.07426
- Prefix/KV cache: байт-идентичный префикс обязателен; локальный llama.cpp не имеет
  частичного reuse, поэтому правка system внутри хода = полный prefill.
  https://handbook.modular.com/inference-optimization/prefix-caching

**Отклонённое решение:** обновлять системный промпт при каждом обращении к файлу
(динамический system-блок). Это противоречит инварианту `frozenMapBlock`
(`src/core/agent/prompt-phase.ts:36-42`, аудит §8.7) и KV-кешу локального провайдера.

## 2. Границы

**Входит:** три волны ниже; контракты `session.jsonl`, `LoadConfigResult`, тула
`project_map`; два словаря i18n; тесты и живой замер стартового контекста.

**Не входит:** загрузка `AGENTS.md` в этой сессии, размер tool result, compaction,
изменение `resolvePromptProfile` для текста промпта и каталога скиллов, CHANGELOG
(правило 10 AGENTS.md — только по явной команде).

Ветка одна, волны — три последовательных коммита; каждая волна зелёная отдельно
(`bun test` + `bun run quality`).

## 3. Волна 1 — честный снимок системного промпта

### Контракт

- `session_start` → событие `system` (`src/core/agent/session-start.ts:115`) пишет
  **полный** системный промпт один раз, без `slice(0, 2000)`. Перед записью текст проходит
  ту же DLP-проекцию/маскировку, что и `llm_request` (`redactContextSecrets` /
  `maskTokenIds`) — в лог не попадают токены-псевдонимы и секреты.
- В событие `system` добавляются поля `chars: number` и `sha256: string` (16 hex).
- Снимок `llm_request.system` остаётся урезанным до 12 000 символов (чтобы не раздувать
  journal), но получает честные поля: `systemClipped?: boolean`, `systemChars?: number`,
  `systemSha256?: string`. По `sha256` Trace/diag может связать снимок с полным текстом
  в событии `system`.
- **Граница корреляции:** hash считается по redacted-тексту **каждого события** (лог — до
  DLP, снимок — после). Для обычного промпта (без секретов и DLP-псевдонимов) hash'ы
  совпадают; если DLP заменил секрет на `[SECRET]`, а лог — на `sk-[REDACTED]`, значения
  расходятся. Это диагностический коррелятор, а не токен безопасности: тащить сырой hash
  через провайдерский санитайзер ради этого случая нецелесообразно.
- Записи `system`, которые пишут `[Excluded prompt blocks: N]`, остаются короткими и
  не являются полным промптом; для них `sha256` не пишется.

### Ошибки

- DLP-проекция fail-open: если маскировка упала, событие `system` не пишется совсем,
  а в лог идёт `error`/diagnostic с причиной; вызов модели не падает.
- Если полный промпт пустой — событие не пишется.

### Тесты

- `tests/llm/request-snapshot.test.ts`: clipped-флаги, длина оригинала, hash.
- `tests/core/session-log-system.test.ts` (новый): полный текст в events, hash совпадает
  со снимком, секреты замаскированы, excluded-block запись короткая.

## 4. Волна 2 — явное значение конфига побеждает autoscaling

### Контракт

- `LoadConfigResult` (`src/config/config.ts:84`) получает `explicitKeys: ReadonlySet<string>`
  — dotted-ключи, реально присутствующие в сырых слоях (legacy `config.json`, домены,
  `.mmrc`) или заданные env. До слияния с `DEFAULTS`.
- `config-phase.ts` и `bootstrap.ts` пробрасывают `explicitKeys` в `workspace-phase.ts`.
- `effectiveMapTokenBudget(configured, defaultBudget, window, threshold, explicit?)`
  (чистая функция, `src/modules/indexer/module.ts`):
  - `explicit === true` → вернуть `configured` как есть (в том числе 1500 = дефолт);
  - `explicit !== true` → текущее поведение (явное значение != дефолт побеждает, иначе
    scale до 6000 на больших окнах).
- `AppConfig`, `DEFAULTS`, registry и панель настроек **не меняются** — гейт
  `default-single-source` остаётся зелёным.

### Тесты

- `tests/config/explicit-keys.test.ts` (новый): ключ из каждого слоя и env попадает в set;
  ключ из DEFAULTS — нет.
- `tests/core/prompt-scale-limits.test.ts`: `effectiveMapTokenBudget(1500, 1500, 200000,
  128000, true) === 1500`; без флага === 6000; произвольное явное значение не scale-ится.

## 5. Волна 3 — ленивая карта и узкие тулы по умолчанию

### Режимы

- Вводится чистая функция `isExplicitLargeProfile(config): boolean` в
  `src/core/system-prompt-render.ts`: true только если `config.promptProfile === "large"`.
  `resolvePromptProfile` не меняется (текст промпта и каталог скиллов остаются как есть).
- `src/core/bootstrap/session-phase.ts:196-202`: `wideByDefault = isExplicitLargeProfile(config)`.
  При `auto`/`full` остаются `enableOnDemand=true` и `activeToolTags = defaultTags`;
  явный `large` сохраняет текущий широкий режим (all tools).
- `IndexerModule` получает `promptMapMode: "full" | "stub"` из bootstrap:
  `isExplicitLargeProfile` → `full`, иначе `stub`.

### Контракт карты

- В `stub`-режиме `getSystemPromptBlock()` возвращает короткий блок (source `indexer`,
  `kind: "project-map"`, priority normal, essential false):
  «Workspace map is not preloaded. Call `project_map` with action `map` (optionally
  `focus=<path>`) to get ranked files and exports; use find/symbol/outline for targeted
  lookups.» Две строки ≤120 символов. Блок участвует в fingerprint, чтобы переход между
  режимами через `/config` пересобирал system.
- Тул `project_map` (`src/modules/indexer/map-tool.ts`) получает действие `map` в enum и
  handler-map. Новый `MapToolHost.getPromptMap(): string | null` отдаёт тот же текст,
  что и системный блок в `full`-режиме (`formatMap` с бюджетом из волны 2).
- Необязательный аргумент `focus: string`: детерминированная переранжировка карты вокруг
  пути — файлы из той же папки, затем файлы с общими экспортами/импортами, затем
  уже считаемый PageRank (`src/modules/indexer/rank.ts`). Без `focus` — прежнее поведение.
  Несуществующий `focus` → `{ success: false, output: ... }` без догадок о пути.
- Вывод `map` ограничен тем же `mapTokenBudget`; superlinear growth не допускается.
- `en.json` и `ru.json`: обновить `indexer.project_map_desc` и
  `indexer.project_map_action_desc` (новые `map` и `focus`), симметрично.

### Ошибки и смежные модули

- `frozenMapBlock` не трогается: внутри хода system имутабелен. Карта по требованию
  приходит **tool result**, а не правкой system.
- `enable_tools` и блок `core: hidden tools` остаются: модель может сама дотянуть
  web/shell/memory-тулы.
- Индекс.build/refresh — best-effort; если индекс недоступен, `map` возвращает
  `indexer.not_indexed`, а не тихую пустую карту.

### Тесты

- `tests/core/prompt-tool-visibility.test.ts` (новый): `auto` на 131K даёт узкие теги;
  явный `large` — все тулы; `enableOnDemand:false` — все тулы; hidden-tools блок присутствует.
- `tests/modules/indexer/map-focus.test.ts` (новый): ранг соседей, отсутствующий focus,
  бюджет, формат вывода.
- `tests/i18n.test.ts` — симметрия ключей; `tests/core/system-prompt-freeze.test.ts` —
  карта по-прежнему заморожена внутри хода.

## 6. Критерии приёма и живая проверка

1. `bun test` и `bun run quality` зелёные после каждой волны.
2. `bun test tests/docs-link-check.test.ts tests/docs-consistency.test.ts` — ссылки новых
   спецификаций и README резолвятся.
3. Живой прогон с изолированным `MMA_CONFIG_DIR` (не трогать реальный `~/.mma`) и локальным
   провайдером:
   - стартовый `context` event: `system+tools` падает с ~17.1K до ~4–5K;
   - `llm_request` несёт `systemSha256` и `systemChars`; в `system` event доступен полный текст;
   - диалог «где описан конфиг?» вызывает `project_map` с `action:"map"` и/или `focus`,
     карта возвращается как tool result;
   - явный `mapTokenBudget: 1500` в конфиге даёт карту ≈1500, а не 6000.
4. Ссылка на `session.jsonl` живого прогона и цифры — в комментарии задачи 8VJYKE.

## 7. Риски

- Модель может не догадаться вызвать `project_map map` — смягчается заглушкой; при
  провале живого прогона усиливаем формулировку, но не возвращаем полную карту в system.
- Сужение тулов может скрыть нужный tool — `enable_tools` и hidden-tools блок дают путь
  восстановления; явный `promptProfile:"large"` — полный откат.
- Ранжировка по `focus` может дать шум в маленьком репозитории — fallback на обычную
  rank-карту, если соседей меньше порога.
