# Прогресс `split-bloated-files` (правило 6 · INV-23)

**Дата:** 2026-10-13 · **Ветка:** `docs/architecture-v2`
**Гейт:** `tests/arch/file-size.test.ts` + [.arch-allowlist.json](../../../.arch-allowlist.json)
(потолки только уменьшаются; при ≤300 запись **обязана** быть снята).
**Долг:** [`docs/agents/debt.md`](../agents/debt.md) → `split-bloated-files`.

## Итог

| | Кол-во |
|---|---|
| Было в allowlist (старт) | 84 |
| Разрезано (запись снята) | **25** |
| Осталось | **59** |
| — из них «не крупные» (< 561 стр.) | 34 |
| — из них крупные (≥ 561 стр.) | 25 |

Флагманы `agent.ts` (561) и `execution/module.ts` (688) уже частично разрезаны ранее
(фазы `core/agent/*`, модули `execution/*`); остаток — оболочка/публичный API.

## Осталось «не крупные» (34) — режем сейчас

В порядке возрастания размера:

| # | Файл | Строк | Предполагаемый шов |
|---|---|---|---|
| 1 | `src/modules/security/path-validator.ts` | 305 | правила/матчеры |
| 2 | `src/modules/webui/server.ts` | 314 | роутинг/буферы |
| 3 | `src/modules/processes/registry.ts` | 360 | трекинг процессов |
| 4 | `src/modules/browser/session.ts` | 362 | playwright-сессия |
| 5 | `src/modules/session/manager.ts` | 368 | мета/смена сессии |
| 6 | `src/modules/webui/settings/setup-api.ts` | 369 | визард first-run |
| 7 | `src/modules/indexer/symbols.ts` | 375 | извлечение символов |
| 8 | `src/core/bootstrap/modules-phase.ts` | 375 | сборка промпт-блоков |
| 9 | `src/modules/security/audit-notifier.ts` | 376 | вебхук/фильтр |
| 10 | `src/tools/question.ts` | 386 | сборка спеков |
| 11 | `src/config/config.ts` | 390 | env-оверрайды/домены |
| 12 | `src/modules/execution/verifier.ts` | 393 | tsc/тесты-прогоны |
| 13 | `src/core/agent/loop-llm.ts` | 399 | калибровка/usage |
| 14 | `src/core/prompt-overflow.ts` | 404 | суммаризация блоков |
| 15 | `src/modules/indexer/walker.ts` | 406 | обход ФС |
| 16 | `src/modules/webui/assets/js/session/tabs.ts` | 413 | вкладки сессий |
| 17 | `src/modules/webui/assets/js/feed/core.ts` | 435 | лента/скролл |
| 18 | `src/modules/plugins/builtin/lint-on-write.ts` | 435 | линт-плагин |
| 19 | `src/cli/main.ts` | 438 | парсинг опций/маршрут |
| 20 | `src/modules/webui/state.ts` | 445 | god-state (роли уже есть) |
| 21 | `src/modules/webui/assets/js/session/composer.ts` | 457 | ввод/отправка |
| 22 | `src/modules/webui/assets/js/settings/write.ts` | 458 | запись настроек |
| 23 | `src/modules/session/store.ts` | 461 | IO сессий |
| 24 | `src/tools/syntax-validator.ts` | 461 | парсер-фолбэки |
| 25 | `src/core/bootstrap/session-runner.ts` | 487 | раннер сессии |
| 26 | `src/modules/lsp/module.ts` | 488 | lifecycle LSP |
| 27 | `src/modules/webui/assets/js/settings/providers.ts` | 488 | UI провайдеров |
| 28 | `src/core/agent/context-log.ts` | 519 | diff-лог |
| 29 | `src/modules/webui/assets/js/sidebar/trace.ts` | 525 | trace-вкладка |
| 30 | `src/modules/mcp/client.ts` | 539 | JSON-RPC/транспорт |
| 31 | `src/tools/executor.ts` | 540 | enforcement/hook-обвязка |
| 32 | `src/modules/plugins/manager.ts` | 541 | реестр плагинов |
| 33 | `src/modules/indexer/module.ts` | 549 | индексатор |
| 34 | `src/modules/security/security-policies.ts` | 556 | таблицы политик |

## Осталось крупные (25) — отдельными волнами

`src/core/agent.ts` 561 · `src/modules/execution/execution-plugin.ts` 561 ·
`src/modules/webui/assets/app.ts` 570 · `src/modules/certification/scenarios.ts` 591 ·
`src/core/session-logger.ts` 606 · `src/modules/lsp/connection.ts` 606 ·
`src/config/types.ts` 615 · `src/modules/execution/module.ts` 688 ·
`src/modules/service/api/tasks-api.ts` 690 · `src/ui/renderer.ts` 693 ·
`src/config/registry.ts` 707 · `src/modules/execution/plan-actions.ts` 736 ·
`src/core/agent/tool-batch.ts` 772 · `src/config/registry-extra.ts` 780 ·
`src/tools/bash.ts` 806 · `src/modules/webui/settings/settings-api.ts` 836 ·
`src/cli/commands.ts` 860 · `src/modules/webui/assets/setup.ts` 863 ·
`src/modules/webui/assets/js/settings/panels.ts` 880 ·
`src/modules/execution/stuck-detector.ts` 886 · `src/llm/openai-compat.ts` 964 ·
`src/core/context/manager.ts` 1129 · `src/ui/line-editor.ts` 1160 ·
`src/cli/repl-commands.ts` 1412 · `src/cli/repl.ts` 1501.

## Уже разрезано (25, запись снята из allowlist)

| Файл | Вынесено в |
|---|---|
| `output/channel.ts` | `output/default-channel.ts` |
| `core/module-host.ts` | `core/module-host-order.ts` |
| `modules/webui/module.ts` | `modules/webui/context-probe.ts` |
| `modules/execution/plan-store.ts` | `modules/execution/plan-store-io.ts` |
| `modules/service/openapi/schemas.ts` | `modules/service/openapi/schema-primitives.ts` |
| `core/bootstrap/session-phase.ts` | `core/bootstrap/tool-context.ts` |
| `modules/webui/session/sessions-api.ts` | `modules/webui/session/session-item.ts` |
| `modules/execution/plan-tool.ts` | `modules/execution/plan-tool-todo.ts` |
| `modules/plugins/drafts.ts` | `modules/plugins/drafts-render.ts` |
| `modules/webui/assets/js/settings/editors.ts` | `.../settings/table-editor.ts` |
| `modules/security/command-validator.ts` | `modules/security/command-sanitizer.ts` |
| `llm/provider-context.ts` | `llm/native-context.ts` |
| `modules/webui/assets/md.ts` | `modules/webui/assets/md-copy.ts` |
| `modules/webui/assets/js/sidebar/files.ts` | `.../sidebar/files/expand.ts` |
| `tools/subagent.ts` | `tools/subagent-run.ts` |
| `modules/lsp/diagnose.ts` | `modules/lsp/diagnose-server.ts` |
| `core/agent/hallucination-gate.ts` | `core/agent/hallucination-claims.ts` |
| `modules/webui/assets/js/feed/turn.ts` | `.../feed/tool-render.ts` |
| `modules/certification/cli.ts` | `modules/certification/cert-report.ts` |
| `modules/mcp/module.ts` | `modules/mcp/tool-shape.ts` |
| `modules/plugins/tools.ts` | `modules/plugins/tool-defs.ts` |
| `ui/md-formatter.ts` | `ui/md-inline.ts` |
| `modules/service/openapi/operations.ts` | `modules/service/openapi/operation-types.ts` |
| `cli/completer.ts` | `cli/completer-providers.ts` |
| `modules/webui/settings/providers-api.ts` | `modules/webui/settings/providers-input.ts` |

## Как проверить

```bash
bun test tests/arch/file-size.test.ts   # гейт D
bun run quality                         # полный гейт (typecheck + check:arch + lint + fallow)
```
