# Прогресс `split-bloated-files` (правило 6 · INV-23)

**Дата:** 2026-10-13 · **Ветка:** `docs/architecture-v2`
**Гейт:** `tests/arch/file-size.test.ts` + [.arch-allowlist.json](../../../.arch-allowlist.json)
(потолки только уменьшаются; при ≤300 запись **обязана** быть снята).
**Долг:** [`docs/agents/debt.md`](../agents/debt.md) → `split-bloated-files`.

## Итог

| | Кол-во |
|---|---|
| Было в allowlist (старт) | 84 |
| Снято из allowlist | **28** (разрезано 25 + уменьшено 3) |
| Осталось | **56** |
| — из них «не крупные» (< 561 стр.) | 33 |
| — из них крупные (≥ 561 стр.) | 23 |

> **Сверка 2026-10-26:** `path-validator.ts`, `webui/server.ts` и
> `webui/settings/setup-api.ts` уже ≤300 и сняты из allowlist без разрезания;
> `execution-plugin.ts` (539) и `lsp/connection.ts` (533) перешли из крупных
> в «не крупные». Размеры в таблицах ниже — снимок на 2026-10-13.

Флагманы `agent.ts` (561) и `execution/module.ts` (688) уже частично разрезаны ранее
(фазы `core/agent/*`, модули `execution/*`); остаток — оболочка/публичный API.

## Осталось «не крупные» (33) — режем сейчас

В порядке возрастания размера:

| Файл | Строк | Предполагаемый шов |
|---|---|---|
| `src/modules/browser/session.ts` | 336 | playwright-сессия |
| `src/modules/security/audit-notifier.ts` | 336 | вебхук/фильтр |
| `src/modules/processes/registry.ts` | 351 | трекинг процессов |
| `src/modules/session/manager.ts` | 354 | мета/смена сессии |
| `src/config/config.ts` | 367 | env-оверрайды/домены |
| `src/core/bootstrap/modules-phase.ts` | 372 | сборка промпт-блоков |
| `src/modules/indexer/symbols.ts` | 375 | извлечение символов |
| `src/core/agent/loop-llm.ts` | 385 | калибровка/usage |
| `src/tools/question.ts` | 386 | сборка спеков |
| `src/modules/execution/verifier.ts` | 393 | tsc/тесты-прогоны |
| `src/core/prompt-overflow.ts` | 398 | суммаризация блоков |
| `src/modules/indexer/walker.ts` | 406 | обход ФС |
| `src/modules/webui/assets/js/session/tabs.ts` | 413 | вкладки сессий |
| `src/modules/lsp/module.ts` | 415 | lifecycle LSP |
| `src/modules/webui/state.ts` | 416 | god-state (роли уже есть) |
| `src/modules/session/store.ts` | 431 | IO сессий |
| `src/modules/webui/assets/js/session/composer.ts` | 433 | ввод/отправка |
| `src/modules/plugins/builtin/lint-on-write.ts` | 435 | линт-плагин |
| `src/modules/webui/assets/js/feed/core.ts` | 435 | лента/скролл |
| `src/cli/main.ts` | 437 | парсинг опций/маршрут |
| `src/modules/webui/assets/js/settings/write.ts` | 453 | запись настроек |
| `src/tools/syntax-validator.ts` | 461 | парсер-фолбэки |
| `src/core/bootstrap/session-runner.ts` | 487 | раннер сессии |
| `src/modules/webui/assets/js/settings/providers.ts` | 488 | UI провайдеров |
| `src/modules/security/security-policies.ts` | 492 | таблицы политик |
| `src/modules/indexer/module.ts` | 497 | индексатор |
| `src/tools/executor.ts` | 515 | enforcement/hook-обвязка |
| `src/modules/webui/assets/js/sidebar/trace.ts` | 517 | trace-вкладка |
| `src/core/agent/context-log.ts` | 519 | diff-лог |
| `src/modules/lsp/connection.ts` | 533 | транспорт/жизненный цикл |
| `src/modules/execution/execution-plugin.ts` | 539 | хуки/обработка тулов |
| `src/modules/mcp/client.ts` | 539 | JSON-RPC/транспорт |
| `src/modules/plugins/manager.ts` | 541 | реестр плагинов |

## Осталось крупные (23) — отдельными волнами

`src/cli/repl.ts` 1471 · `src/cli/repl-commands.ts` 1187 · `src/ui/line-editor.ts` 1156 ·
`src/core/context/manager.ts` 1101 · `src/llm/openai-compat.ts` 951 ·
`src/modules/webui/assets/js/settings/panels.ts` 880 ·
`src/modules/webui/assets/setup.ts` 863 · `src/tools/bash.ts` 799 ·
`src/core/agent/tool-batch.ts` 771 · `src/modules/execution/stuck-detector.ts` 766 ·
`src/config/registry-extra.ts` 755 · `src/modules/webui/settings/settings-api.ts` 738 ·
`src/modules/execution/plan-actions.ts` 735 · `src/config/registry.ts` 707 ·
`src/ui/renderer.ts` 693 · `src/modules/execution/module.ts` 688 ·
`src/cli/commands.ts` 685 · `src/core/session-logger.ts` 603 ·
`src/modules/service/api/tasks-api.ts` 596 ·
`src/modules/certification/scenarios.ts` 591 · `src/config/types.ts` 574 ·
`src/modules/webui/assets/app.ts` 569 · `src/core/agent.ts` 561.

## Уже разрезано (25, запись снята из allowlist)

Дополнительно без разрезания уменьшены до ≤300: `path-validator.ts`,
`webui/server.ts`, `webui/settings/setup-api.ts`.

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