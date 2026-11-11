# Гейты и инварианты

Что проверяется автоматически и чем. Правило [AGENTS.md §5](../../AGENTS.md): новый инвариант
сразу получает гейт, иначе он живёт до следующего крупного изменения.

## Как прогнать

```bash
bun test                    # всё, включая гейты ниже
bun run quality             # typecheck + frontend + check:arch + lint + fallow
bun run check:arch          # только tests/arch + tests/output
bun test tests/arch         # один набор
```

`bun run quality` **не** запускает всю сюиту — только архитектурные гейты. Полный прогон —
`bun test`.

## Инвариант → гейт

| Инвариант | Гейт |
| --- | --- |
| Модуль не импортирует ядро напрямую (INV-3/4) | `tests/arch/module-boundaries.test.ts` |
| Enforcement в одной точке (INV-9/10) | `tests/tools/security-decl.test.ts`, `tests/tools/enforcement-*.test.ts` |
| Единственный писатель терминала | `tests/output/no-direct-console.test.ts`, `tests/output/source-filled.test.ts` |
| Дефолты не дублируются по коду | `tests/arch/default-single-source.test.ts` |
| Файл ≤300 строк | `tests/arch/file-size.test.ts` |
| Долги не осиротели (пометка ↔ реестр) | `tests/arch/debt-register.test.ts` |
| Стиль чата по STYLE.md | `tests/arch/style-rules.test.ts` |
| Таймауты согласованы между слоями | `tests/arch/timeout-relations.test.ts` |
| Платформенные скипы объявлены | `tests/arch/platform-skips.test.ts` |
| Провенанс сессии/событий | `tests/arch/session-provenance.test.ts` |
| Fail-open оставляет сигнал (INV-15) | `tests/arch/observability-coverage.test.ts` |
| Подсказки модели не расходятся с enforcement | `tests/arch/guidance-enforcement.test.ts` |
| Опции LLM-вызова задаются в одном месте | `tests/arch/llm-call-options.test.ts` |
| Каталог команд и handler-map | `tests/core/command-catalog.test.ts` |
| Стратегия reasoning резолвится провайдером (INV-R) | `tests/core/reasoning-strategy-resolve.test.ts` |
| Воспроизводимость ходов | `tests/replay/invariants.test.ts` |
| Тенант и авторизация сервиса | `tests/service/tenant-authz.test.ts` |
| XSS/HTML-стоки во фронтенде | `tests/webui-xss-guard.test.ts` |
| Бета: версия < 1.0.0 | `tests/version-beta.test.ts` |
| Ссылки в Markdown резолвятся | `tests/docs-link-check.test.ts` |

## Где что лежит

| Каталог | Что держит |
| --- | --- |
| `tests/arch/` | архитектурные инварианты; сюда добавляется новый гейт |
| `tests/output/` | единственный писатель терминала, формат вывода |
| `tests/tools/` | поведение тулов и их границы (scope, allowlist, SSRF, workdir-jail) |
| `tests/security/` | DLP, taint, SSRF, egress, шифрование at-rest |
| `tests/core/` | петля, контекст, компакция, провайдеры, сессии |
| `tests/modules/` | lsp, indexer, skills, memory, browser, setup, updater |
| `tests/webui-*.test.ts` | веб-поверхность: лимиты, SSE, XSS, i18n, DOM |
| `tests/service/` | HTTP API v1: тенант, идемпотентность, SSE-лимиты |
| `tests/replay/` | повтор хода по логу |
| `tests/integration/`, `tests/e2e/` | **вне** `bun test` — отдельные конфиги (`test:integration`, `test:e2e`) |

## Ворота CI

| Где | Что гоняет |
| --- | --- |
| `bun run quality` (локально и CI) | typecheck, frontend typecheck, `check:arch`, Biome, fallow |
| CI `quality` | плюс coverage **87% funcs / 90% lines**, `evals:check`, `tests/replay` |
| CI `quality-posix` | `tests/arch`, `tests/core`, `tests/tools` на Linux |
| pre-push на `master`/`main` | `bun run quality && bun test` (обход `--no-verify`) |

Coverage-порог — `scripts/coverage-check.ts`. Это значит: локально зелёные `bun test` и `quality`
не гарантируют зелёный CI — проверяй затронутые гейты и покрытие.

## Правила пополнения

1. Новый инвариант — тест в `tests/arch/` (или `tests/output/`), затем строка в таблице выше.
2. Гейт не дублирует реализацию и не проверяет приватные детали: только контракт.
3. Если правило проверить нельзя — это долг в [debt.md](./debt.md) с триггером, а не «текст в доке».
4. Перечень файлов не поддержан вручную: полный список — `ls tests/arch`; историю фич смотри в
   [feature-history.md](./feature-history.md).
