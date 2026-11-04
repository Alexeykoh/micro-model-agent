# Авто-поиск ошибки в интернете при повторяющихся сбоях

> **Дата:** 2026-08-18
> **Статус:** согласован, готов к реализации
> **Версия MMA:** 0.42.0 (MINOR)

## Проблема

Агент (особенно 9B-модель) при повторяющейся ошибке в одной и той же задаче
застревает в цикле «тот же инструмент → та же ошибка → ретрай». Существующие
механизмы (`StuckDetector`, recovery-инъекции, `getActionableHints`) помогают
шаблонными подсказками, но не дают агенту _новой информации_ о конкретной
ошибке. В результате на нетривиальных ошибках (незнакомый API, несовместимость
версий, специфичные для фреймворка сбои) агент повторяет один и тот же неудачный
подход до сдачи.

## Цель

Когда **одна и та же ошибка повторяется ≥ 5 раз**, агент автоматически ищет её в
интернете и получает результаты в контекст. Поиск:

- выполняется самим плагином (не моделью), надёжно и детерминированно;
- не блокирует цикл агента;
- срабатывает только на значимый текст ошибки (не на «exit code 1»);
- ограничен по частоте (анти-зацикливание, кап на сессию).

## Подход (принятые решения)

1. **Триггер** — счётчик повторений одной сигнатуры ошибки (`тул::нормализованный
текст`), порог 5.
2. **Исполнитель** — плагин `execution` вызывает общую функцию
   `performWebSearch()` напрямую (рефакторинг `web-search.ts`).
3. **Формирование запроса** — до 3 значимых строк ошибки + контекст рантайма
   (bun/node/deno/python/npm/pip/tsc + фреймворк из шага), без абсолютных путей.
4. **Неблокирующий запуск** — fire-and-forget в `onAfterTool`, результат уходит в
   `pendingMessages` на следующую итерацию.
5. **Лимиты** — 1 поиск на сигнатуру, кап `maxSearchesPerSession: 3`, допускается
   1 уточнённый повтор при пустых результатах.
6. **Мастер-выключатель** — фича привязана к `webSearch.enabled`: если веб-поиск
   выключен, авто-поиск ошибки тоже не работает (плюс собственный
   `errorWebSearch.enabled`).

## Архитектура

```
StuckDetector (src/modules/execution/stuck-detector.ts)
  ├── errorSignatureCounts: Map<string, number>   # тул::нормализованная ошибка
  ├── searchedErrorSignatures: Set<string>        # anti-повтор
  ├── recordToolError(tool, output) → обновляет счётчик сигнатур
  ├── getRepeatedErrorSignature(): string | null  # сигнатура с count >= threshold
  ├── isSearchableError(output): boolean          # гейт «стоит ли искать»
  ├── buildSearchQuery(stepDesc, bashCmd): string # формирование запроса
  └── markErrorSearched(sig) / hasErrorSearched(sig)

performWebSearch (src/tools/web-search.ts)
  └── извлечена из handler web_search; общий для тула и плагина

execution-plugin.ts (onAfterTool)
  └── при достижении порога: проверки (гейт, кап, searched) → запуск поиска
      без await → результат в pendingMessages
```

### StuckDetector — новые поля и методы

```typescript
private errorSignatureCounts: Map<string, number>;
private searchedErrorSignatures: Set<string>;

constructor(threshold = 6, errorThreshold = 3, webSearchThreshold = 5)

recordToolError(toolName, output?):
  // существующая логика + подсчёт сигнатуры
  const sig = normalizeErrorSignature(toolName, output);
  if (sig) errorSignatureCounts.set(sig, (get || 0) + 1);

getRepeatedErrorSignature(): string | null
  // первый ключ с count >= webSearchThreshold, ещё не искавшийся

getErrorSignatureCount(sig): number

markErrorSearched(sig): void
hasErrorSearched(sig): boolean

isSearchableError(output): boolean
  // true, если вывод содержит значимый фрагмент ошибки:
  //  - TS-коды (error TS\d+), ERR_*, ENOENT/EACCES/ECONNREFUSED и т.п.
  //  - TypeError / ReferenceError / Cannot find module / Module not found
  //  - "error:" + хотя бы один стек-фрейм / путь
  //  - "Command failed with exit code N" ТОЛЬКО вместе с дополнительной строкой
  // false для пустого вывода и тривиальных "exit code 1" без деталей

buildSearchQuery(stepDescription, lastBashCommand): string
  // 1. первые до 3 значимых строк из lastErrorOutput
  // 2. вырезать абсолютные пути, номера строк вида file.ts:12:34, таймстемпы, ANSI
  // 3. схлопнуть пробелы, cap maxQueryChars
  // 4. контекст рантайма из stepDescription/lastBashCommand:
  //    bun|node|deno|python|npm|pip|tsc|tsx → "<runtime> <query> how to fix"
  //    + фреймворк из шага (react|vite|express|next|nest) если найден
  // 5. fallback: "<toolName> <stepDescription>" если ошибка незначимая

reset(): также очищает errorSignatureCounts и searchedErrorSignatures
resetStepProgress()/resetStepState(): то же
```

**Нормализация сигнатуры** (`normalizeErrorSignature`): `тул::` + первые 1–2
непустые строки вывода, обрезанные от ANSI, абсолютных путей и номеров строк,
схлопнутый пробел, до ~120 символов. Если после очистки строка пуста —
сигнатура не учитывается.

### performWebSearch — рефакторинг

Из `handler` тула `web_search` выносится тело в:

```typescript
export async function performWebSearch(
  query: string,
  numResults: number,
  networkConfig: NetworkSecurityConfig | undefined,
): Promise<{ success: boolean; results: SearchResult[]; error?: string }>;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}
```

`SearchResult` — данные без i18n-обёрток. Форматирование в результаты тула и в
инжекцию остаётся на вызывающей стороне. Поведение тула не меняется (тот же
DuckDuckGo, та же валидация через `isUrlAllowed`/`logNetworkRequest`).

### execution-plugin.ts — onAfterTool

После существующего `recordToolError` (в ветке `!result.success`, а также в ветке
«успех с typecheck-ошибкой» — там, где уже вызывается `recordToolError`):

```typescript
deps.maybeSearchError(ctx, call); // синхронная — не блокирует возврат результата
```

`maybeSearchError` (в `ExecutionModule`) — **синхронная** функция (запускает
сетевой вызов без ожидания). Порядок проверок:

1. `config.webSearch?.enabled !== false` (мастер-выключатель веб-поиска) И
   `config.errorWebSearch?.enabled !== false`? иначе return;
2. `const sig = stuckDetector.getRepeatedErrorSignature()` — null → return;
3. если `stuckDetector.hasErrorSearched(sig)` И сигнатуры нет в
   `retryWebSearchSignatures` → return (анти-повтор);
4. `searchesThisSession >= config.errorWebSearch.maxSearchesPerSession` → return;
5. `stuckDetector.isSearchableError(lastErrorOutput)` — false → return;
6. построить запрос: `stuckDetector.buildSearchQuery(stepDesc, lastBashCmd)`;
7. `stuckDetector.markErrorSearched(sig)`, `searchesThisSession++`;
8. запустить **без await** (fire-and-forget):

```typescript
performWebSearch(query, maxResults, networkConfig)
  .then((res) => {
    if (!res.success || res.results.length === 0) {
      // Пусто/сбой: ничего не инжектим, логируем. Разрешаем ОДИН уточнённый
      // повтор для этой сигнатуры (обход шага 3): добавляем sig в
      // retryWebSearchSignatures — следующий getRepeatedErrorSignature()
      // вернёт её снова, и запрос будет дополнен рантаймом, если его ещё не
      // было. Второй пустой результат — окончательно.
      if (!retryWebSearchSignatures.has(sig)) {
        retryWebSearchSignatures.add(sig);
      }
      ctx.sessionLog?.plan("web-search", `empty/failed: ${query}`);
      return;
    }
    deps.pendingMessages.push({
      role: "user",
      content: `<system-summary>${t("exec.error_search_results", {...})}</system-summary>`,
    });
  })
  .catch((e) => ctx.logger?.warn(`error web search: ${e.message}`));
```

**Уточнённый повтор при пустых результатах:** `retryWebSearchSignatures:
Set<string>` (поле модуля). При пустом/проваленном первом поиске сигнатура
добавляется в набор → шаг 3 пропускает её один раз → поиск повторяется с
запросом, дополненным рантаймом (если его ещё не было). Второй пустой результат
(сигнатура уже в наборе, а `hasErrorSearched` — true) → возврат на шаге 3,
поиск для этой сигнатуры завершён. Повтор не чаще, чем через
`STUCK_RECOVERY_COOLDOWN` итераций (защита от мгновенного двойного запроса на
той же итерации).

**Сетевой конфиг:** как в туле — `getSessionSecurityConfig(ctx.config,
ctx.sessionContext).network`.

**Поля модуля:** `searchesThisSession: number` (сбрасывается только в новом
`Agent.run`), `retryWebSearchSignatures: Set<string>`.

### Инжектируемый блок

`<system-summary>` из `exec.error_search_results`:

```
Ошибка "<сигнатура>" повторилась N раз. Поиск в интернете нашёл:
1. <title> — <url>
   <snippet>
...
Примени подходящее решение из результатов. Если ни один результат не релевантен
твоей ситуации — НЕ повторяй тот же подход, смени стратегию или честно сообщи о
застревании.
```

Формат строки — через `t()` (en+ru), суммарно ≤ 1500 символов (усечение
сниппетов, `maxResults` по умолчанию 5).

## Конфиг

`src/config/types.ts` — новые типы и поля:

```typescript
/**
 * Мастер-выключатель веб-поиска. Единая точка отключения: когда enabled=false,
 * тул web_search возвращает «отключён», а авто-поиск ошибки (errorWebSearch)
 * не срабатывает — фича завязана на этот переключатель.
 */
export interface WebSearchConfig {
  enabled: boolean; // (true)
}

export interface ErrorWebSearchConfig {
  enabled: boolean;           // независимый переключатель самой фичи (true)
  threshold: number;          // повторений одной ошибки для триггера (5)
  maxResults: number;         // результатов в инжекции (5)
  maxQueryChars: number;      // длина запроса (200)
  maxSearchesPerSession: number; // кап на сессию (3)
  requestTimeoutMs: number;   // таймаут сети (10000)
}

// в AppConfig:
webSearch?: WebSearchConfig;
errorWebSearch?: ErrorWebSearchConfig;
```

`src/config/defaults.ts` — значения по умолчанию из таблицы. `threshold`
пробрасывается в `StuckDetector` конструктором (как `stuckThreshold`). Плагин/модуль
читает остальные поля из `config.errorWebSearch`.

### Привязка к отключению веб-поиска

Фича срабатывает **только при `config.webSearch?.enabled !== false` И
`config.errorWebSearch?.enabled !== false`**. То есть:

- `webSearch.enabled: false` → авто-поиск ошибки выключен, независимо от
  `errorWebSearch`;
- `errorWebSearch.enabled: false` → выключен только авто-поиск, ручной `web_search`
  работает.

Кроме того, мастер-выключатель применяется к самому тулу `web_search`: в handler
добавляется проверка `config.webSearch?.enabled ?? true` — при `false` тул
возвращает `success: false` с `t("tool.web_search_disabled")` (тул остаётся в
реестре, чтобы сужение набора тулов по тегам не ломалось, но фактически не
работает).

## i18n (en + ru)

| Ключ                         | Назначение                                             |
| ---------------------------- | ------------------------------------------------------ |
| `exec.error_search_results`  | Инжектируемый блок с результатами поиска               |
| `exec.error_search_failed`   | Лог/мета при сбое поиска                               |
| `exec.error_search_no_query` | Лог при незначимой ошибке (поиск пропущен)             |
| `tool.web_search_disabled`   | Ответ тула `web_search` при `webSearch.enabled: false` |

## Тесты

**`tests/execution-stuck-detector.test.ts` (или новый файл сигнатур):**

- подсчёт сигнатур: разные ошибки не смешиваются, `тул::нормализованный текст`;
- порог: `getRepeatedErrorSignature()` возвращает сигнатуру при count >= threshold
  и `null` до него;
- нормализация: ANSI, абсолютные пути, `file.ts:12:34`, схлопывание пробелов;
- `isSearchableError`: true для `error TS2322`, `ENOENT`, `Cannot find module`,
  `Command failed with exit code 1` + деталь; false для пустого вывода и голого
  `exit code 1`;
- `buildSearchQuery`: 3 строки стека, вырезанные пути, добавление рантайма из
  шага/bash-команды, fallback «тул + шаг», cap `maxQueryChars`;
- searched-флаг: повторный поиск для той же сигнатуры не выдаётся;
- сброс всех новых структур в `reset()/resetStepProgress()/resetStepState()`.

**`tests/execution-scenario-tests.test.ts` (onAfterTool):**

- 5 повторений ошибки → `performWebSearch` вызван 1 раз, результат в
  `pendingMessages`;
- незначимая ошибка → поиск не вызывается;
- кап сессии: после `maxSearchesPerSession` поисков — тишина;
- пустой результат → ничего не инжектится, логируется, допускается уточнённый
  повтор;
- поиск не блокирует возврат результата тула (fire-and-forget — результата в
  `pendingMessages` может не быть на той же итерации);
- `webSearch.enabled: false` → авто-поиск ошибки не вызывается даже при 5+
  повторениях, `errorWebSearch.enabled: false` → аналогично;
- тул `web_search` при `webSearch.enabled: false` возвращает
  `tool.web_search_disabled`.

**`tests/web-search.test.ts`** (после рефакторинга): тул продолжает работать —
результаты форматируются как раньше, `performWebSearch` возвращает
`SearchResult[]`, сбой сети → `{ success: false }`.

## Критерии приёмки

- `bun test` зелёный, `tsc --noEmit` чистый, `build:prod` собирается.
- В sandbox-прогоне (`_testing/`) с инъекцией ошибки ≥ 5 раз модель получает
  результаты поиска в контексте и меняет подход (или честно стопорится).
- Сетевая недоступность не ломает цикл (best-effort).
- Новый конфиг опционален: без него поведение идентично 0.41.x.
- `webSearch.enabled: false` полностью отключает и тул `web_search`, и авто-поиск
  ошибки; `errorWebSearch.enabled: false` отключает только авто-поиск.
