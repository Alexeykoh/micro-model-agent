# Language adapters for the syntax verifier — design

> **Дата:** 2026-11-03. Phase C плана
> `docs/superpowers/plans/2026-08-12-memory-quality-and-learning.md` (TODO §1.6).

## Проблема

`Verifier.validateSyntax` знает только TypeScript (`tsc --noEmit`) и JS
(`node --check`); для Python/Ruby/PHP/JSON/shell проверка молча возвращает
`true`, то есть «синтаксис валиден» — ложное подтверждение.

## Контракт

`src/modules/execution/language-adapters.ts`:

```ts
export type SyntaxCheck =
  | { kind: "command"; command(file: string): string; timeoutMs: number }
  | { kind: "json" };

export function adapterForExt(ext: string): SyntaxCheck | null;
```

Таблица (расширение → проверка):

| Расширения | Проверка |
|---|---|
| `.py`, `.pyi` | `python -m py_compile "<file>"` (10 с) |
| `.rb` | `ruby -c "<file>"` (10 с) |
| `.php` | `php -l "<file>"` (10 с) |
| `.sh`, `.bash` | `bash -n "<file>"` (10 с) |
| `.json` | `JSON.parse` в процессе |

Нет бинарника (`127`/`ENOENT`) → `degrade("verify.syntax", reason)` и
`true` (fail-open, как у отсутствующего `tsc`). Ошибка синтаксиса → `false`.
TS/JS остаются на прежних ветках и адаптер не переопределяют.

## Гейты

`tests/modules/execution/language-adapters.test.ts` (таблица + JSON),
`tests/verify-language-adapters.test.ts` (битый/валидный Python и JSON через
`Verifier`, отсутствующий бинарник деградирует, а не падает).
