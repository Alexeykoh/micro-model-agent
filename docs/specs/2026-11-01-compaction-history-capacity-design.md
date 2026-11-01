# Бюджет истории с учётом измеренных toolTokens

_Дата: 2026-11-01. Ветка: `fix/compaction-history-threshold`. Статус: реализуется._

## 1. Что наблюдается

Живой прогон `mma web` (окно 32768, конфиг `systemPrompt 0.1`, `responseReserve 0.15`):

```
overflow (41300 > 24577), iteration 1 - tokens 59899→37740 (-22159)
```

- `41300` — калиброванная **история** (`check.calibrated`), `24577` — `budget.history`.
  То есть порог «история против истории» уже работает (закрыто 2026-10-22,
  `tests/core/history-budget-threshold.test.ts`); дефекта «total вместо history» нет.
- Но `24577` — не то пространство, которое реально остаётся истории. В том же окне
  измерены `systemTokens ≈ 3093` и `toolTokens ≈ 9025`, плюс `responseReserve 4915`.
  Промпт на пороге: `24577 + 3093 + 9025 = 36695 > 32768`. Порог разрешает
  контекст, который **уже больше окна** на ~3.9K; в живом прогоне он сработал на
  41.3K истории, когда фактический промпт был в 1.6× больше окна.

## 2. Причина

`calculateBudget()` (`src/core/context/manager.ts`) делит окно:

```
history = window − systemBudget − responseReserve
```

`toolTokens` в этой формуле нет: схемы тулов становятся известны только в рантайме
(`setToolTokens`), а `budget.history` считается один раз при `resize`. Спека
`2026-10-14-out-of-context-corpus-design.md` §5 считает, что статическая доля под
тулы не нужна, потому что `toolTokens` вычитается из оценки истории
(`getContextTokens() − system − tools`). Это верно для **измерения** истории, но не
для **предела**, с которым она сравнивается: предел `budget.history` тулы не
учитывает, поэтому сумма `system + tools + history` может превысить окно ровно на
`toolTokens − (systemBudget − systemTokens)`.

Пробник на текущем коде (окно 32768, system 3093, tools 9025, история 24600):

```
breakdown:     { used: 36718, window: 32768, overcommitted: true }
checkOverflow: { allowed: true, calibrated: 24600 }
```

`overcommitted: true` и `allowed: true` одновременно — порог сработал позже окна.

## 3. Контракт

### 3.1 Новое понятие: ёмкость истории (`getHistoryLimit()`)

```
historyLimit = max(0, min(budget.history, window − responseReserve − systemTokens − toolTokens))
```

- `budget.history` остаётся **конфигурной долей** окна и продолжает управлять
  cap'ом вывода инструментов (`tool-output.ts`) и `computeMinReduction` — менять их
  в этой задаче нельзя (другой контракт, другая задача).
- `min(...)` не даёт ёмкости вырасти выше конфигурной доли, даже если system и тулы
  малы: конфиг по-прежнему главный верхний предел.
- Ёмкость зависит от **фактических** `systemTokens()` и `toolTokens`, то есть
  пересчитывается на лету, без изменения `budget`.

### 3.2 Пороги сравнивают историю с ёмкостью

Меняются три места, и только они:

| Место | Было | Стало |
|---|---|---|
| `needsCompaction()` (soft, pending после тула) | `history > budget.history × compactionThreshold` | `history > historyLimit × compactionThreshold` |
| `needsIntervalCompaction()` (load интервала) | `history / budget.history` | `history / historyLimit` |
| `checkOverflowAllowed()` (hard) | `history > budget.history` | `history > historyLimit` |

Инвариант: в точке жёсткого порога `used + responseReserve == window` (с точностью
до шага оценки). Порог больше не может разрешить промпт больше окна.

### 3.3 Лог говорит правду

`compaction.ts` в причине overflow печатает предел, с которым реально сравнивали
(`getHistoryLimit()`), а не `budget.history` — иначе строка «41300 > 24577» вводит в
заблуждение.

### 3.4 Чего контракт не делает

- Не меняет `budget.history`, `getBudget()`, `snapshot.budget` и
  `breakdown.historyBudget` (это конфигурная доля; её видят UI и cap тулов).
- Не трогает `qualityFactors().load` — оценка качества остаётся относительно
  конфигурной доли. Это отдельная настройка, её изменение сдвинет
  quality-triggered компакцию; в этой задаче такого сдвига не хотим.
- Не меняет legacy-политику (она воспроизводит 2.18.2).
- Не добавляет новых ключей конфига: ёмкость — рантайм-величина, не настройка.

## 4. Не-цели

- Поздняя компакция после прерванного хода (порог срабатывает, но только в начале
  следующей итерации). Это отдельный дефект момента вызова; здесь меняется только
  порог.
- Reactive-компакция по 413 — не трогаем.

## 5. Тесты

| Файл | Что держит |
|---|---|
| `tests/core/compaction-tool-budget.test.ts` | `getHistoryLimit()` = `window − reserve − system − tools` и не больше `budget.history` |
| то же | история между новой ёмкостью и старым `budget.history` (15800 при лимите 15735) → `checkOverflowAllowed().allowed === true`, `used + reserve ≤ window + шаг` (до правки — `allowed === false`) |
| то же | soft-порог: 75 % считается от ёмкости (11850 → `needsCompaction() === true`; до правки — false) |
| то же | без тулов ёмкость = `min(budget.history, window − reserve − system)` — деградация к прежнему поведению при малых тулах |
| `tests/core/history-budget-threshold.test.ts` | не ломается: порог по-прежнему про историю, а не про total |
| `tests/context-manager.test.ts` | `getBudget().history` и `snapshot.budget.history` не изменились |

## 6. План

1. Спека.
2. `manager.ts`: `historyCapacity()` + `getHistoryLimit()`; триггеры на ёмкость.
3. `compaction.ts`: причина overflow печатает `getHistoryLimit()`.
4. Тесты: новый гвард + прогон существующих контекстных тестов.
5. `bun test` + `bun run quality`; живой прогон: сессия с большими тулами
   (32K окно) — компакция должна срабатывать до `used > window`, в логе
   `overflow (history > historyLimit)`.
