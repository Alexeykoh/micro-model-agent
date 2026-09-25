# `fallow security` — triage (2026-09-25)

**Command:** `bun run fallow:security` (`fallow security`)
**Result:** 34 кандидатов (CWE-78 command injection, CWE-918 SSRF). Это **не подтверждённые
уязвимости** — инструмент подсказывает точки для ручной проверки.

## Command injection (CWE-78)

| Сайт | Как запускается | Статус |
|---|---|---|
| `tools/grep-tool.ts:30` | `spawn(bin, args)` без shell | **safe** — argv-массив, shell выключен |
| `tools/syntax-validator.ts:29` | `spawn(file, args)` без shell | **safe** — исправлено в аудите (W-3 класс) |
| `plugins/builtin/lint-on-write.ts:380,386` | `spawn(file, args)` без shell | **safe** — исправлено в аудите |
| `modules/certification/runner.ts:218` | `spawn(process.execPath, args)` | **safe** — argv |
| `cli/relaunch.ts:29` | `spawnSync(process.execPath, args)` | **safe** — argv |
| `modules/processes/registry.ts:121` | `spawn(command, {shell:true})` | **project-controlled**: команда из bash-тула, проходит `isCommandAllowed` (blacklist/whitelist/operators) |
| `modules/webui/util.ts:267` | `exec("xdg-open …")` в tryOpenBrowser | **safe** — API-константа, URL только локальный bind |
| `modules/mcp/client.ts:162`, `modules/lsp/client.ts:163,179,214` | `spawn(config.command, args)` | **user-configured** (MCP/LSP server command) — не model-controlled |
| `core/environment.ts:115` | env-скан (`which`/`where`) | **safe** — фиксированные имена инструментов |
| `modules/execution/verifier.ts:367` | `spawn(\`${tsc} --noEmit\`)` shell | **project-controlled** — `resolveTscCommand` даёт локальный путь к tsc; не model-input |
| `modules/lsp/startup-check.ts:117` | `spawn(\`${tsc} --noEmit --skipLibCheck\`)` shell | **project-controlled**, как выше |

Класс «model-supplied path в shell» (самый опасный) закрыт в аудите (W-1/W-3): `lint-on-write`,
`syntax-validator`, `download_file`/web-* теперь без shell либо с ре-валидацией.

## SSRF (CWE-918)

Все сайты используют URL из **пользовательского/провайдерского конфига** либо уже гейтятся политикой:

- `llm/model-loader.ts:54,125,158`, `modules/providers/preflight.ts:68`, `modules/setup/discovery.ts:29,49`
  — baseUrl активного провайдера (локальный LM Studio / выбранный хост). Не model-controlled.
- `llm/provider-budget.ts:54`, `modules/updater/checker.ts:69` — фиксированные API (OpenRouter, npm).
- `tools/web-search.ts:46`, `tools/web-browse.ts`, `web-fetch`, `download-file`, `attach-image`
  — проходят `isUrlAllowed` + `fetchValidated` (ре-валидация каждого редиректа, IPv6-loopback).
- `modules/mcp/client.ts:61,329,365,450,497` — URL MCP-сервера из `config.mcpServers`.
- `llm/openai-compat.ts:764,807`, `llm/image-utils.ts:111` — запросы к провайдеру.
- `modules/security/audit-notifier.ts:287` — webhook из конфига аудита.

## Итог

Новых actionable-находок нет: либо argv без shell, либо shell с project/пользовательским
(не модельным) вводом, либо SSRF-поток из пользовательского конфига, уже ограниченный политикой.
Пункт P3 «`fallow security`» закрыт как пройденный; при желании — углублённый ручной прогон позже.
