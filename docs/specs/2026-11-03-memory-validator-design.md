# Memory quality gate (validator) — design

> **Дата:** 2026-11-03. Закрывает Phase A плана
> `docs/plans/2026-08-12-memory-quality-and-learning.md` (TODO §1.6).
> Контракт: `MemoryStore.append/appendRule` возвращают `ValidationResult`; запись
> в `*.md` происходит только при `accepted: true`.

## Проблема

Для 9B-модели мусор в памяти — не косметика: `errors.md`/`conventions.md`
попадают в системный промпт, и следующая сессия учится на этом мусоре
(«self-reinforcing memory corruption»). Валидация должна быть детерминированной
и стоять в точке записи, не в генерации.

## Контракт

```ts
export interface ValidationResult { accepted: boolean; reason?: string }
export class MemoryValidator {
  constructor(memoryDir: string, opts?: ValidatorOptions)
  validate(category: string, entry: string): ValidationResult
  validateRule(category: string, pattern: string, cause: string, solution: string): ValidationResult
}
```

`ValidatorOptions`: `enabled` (default true), `minChars` (15), `minWords` (3),
`similarityThreshold` (0.8).

`MemoryStore(memoryDir, validatorOpts?)`: при `enabled !== false` создаёт
валидатор. `append` и `appendRule` возвращают `ValidationResult`; при отказе
файл не трогается. Существующие вызовы, игнорирующие результат, остаются
валидными по типам.

`remember` при отказе отвечает `success:false` c `tool.remember.rejected`
(причина + просьба переформулировать конкретно). Авто-правила харнесса
(`failure-memory`, `tool-batch`) логируют отказ и не падают.

## Правила (детерминированные)

- мусор: `-`, чекбокс `[x] …`, заголовок `#…`, жирный заголовок `**…**`,
  только скобки, только число, одна буква;
- длина: `< minChars`; меньше `minWords` значимых слов (слова > 2 символов,
  стоп-слова исключены);
- `preferences` — `key=value` (длина не применяется);
- `errors` — не короче 20 символов; `facts` — значимые слова;
- дубликаты: точное совпадение и Jaccard по токенам ≥ threshold;
- русский и английский проверяются одинаково.

## Конфиг

`memory.validator.{enabled,minChars,minWords,similarityThreshold}` в
`DEFAULTS` + `registry-extra` (домен `agent`). Значения по умолчанию совпадают
с `ValidatorOptions`.

## Гейты

`tests/modules/memory/validator.test.ts`, `store-gate.test.ts`,
`tests/tools/remember.test.ts` (отказ), `tests/config/memory-validator.test.ts`
(ключи), плюс существующие memory-тесты не меняют поведения при валидных
записях.
