# Живые спеки

Здесь остаются спеки, которые описывают **действующий контракт**, и работы последней
недели. Завершённые спеки переезжают в [`../archive/specs/`](../archive/README.md).

## Нормативные контракты

Ядро и архитектура:

- [architecture v2](./2026-10-12-architecture-v2-design.md) — целевой каркас, инварианты `INV-1…23`
- [architecture v2 — схемы](./2026-10-12-architecture-v2-schematics.md)
- [remove-moe](./2026-10-12-remove-moe-design.md) — почему MoE удалён
- [W1: ModuleHost](./2026-10-13-w1-module-host-design.md)
- [W2: enforcement](./2026-10-13-w2-enforcement-design.md)
- [W3: ConfigStore](./2026-10-13-w3-config-store-design.md)

Безопасность и политика:

- [outbound policy](./2026-10-15-outbound-policy-design.md)
- [corporate data policy](./2026-10-19-corporate-data-policy-design.md)

Провайдеры и LLM:

- [provider module](./2026-08-20-provider-module-design.md)
- [reasoning strategy](./2026-10-15-reasoning-strategy-design.md)
- [model certification](./2026-08-05-model-certification-design.md)
- [system prompt v3](./2026-10-31-system-prompt-v3-design.md)

Тулы, документы, команды:

- [plugin registry](./2026-10-07-plugin-registry-design.md)
- [documents module](./2026-10-16-documents-module-design.md)
- [REPL commands UX](./2026-09-22-repl-commands-ux-design.md)
- [turn runtime gate](./2026-10-28-turn-runtime-gate-design.md)

Поверхности:

- [agent service API](./2026-10-08-agent-service-api-design.md)
- [webui sidebar tabs](./2026-09-30-webui-sidebar-tabs-design.md)
- [lsp doctor](./2026-10-02-lsp-doctor-design.md)

## Активные работы

Спеки за последнюю неделю (2026-10-30 …) — текущий контекст, а не вечный контракт:

- [audit test-run budget](./2026-10-30-audit-test-run-budget-design.md)
- [critic latency](./2026-10-30-critic-latency-design.md)
- [DLP tool identifiers](./2026-10-30-dlp-tool-identifiers-design.md)
- [multiline fidelity](./2026-10-30-multiline-fidelity-design.md)
- [plan-check path scope](./2026-10-30-plan-check-path-scope-design.md)
- [retract only on re-answer](./2026-10-30-retract-only-on-reanswer-design.md)
- [retract visibility](./2026-10-30-retract-visibility-design.md)
- [webui provider single source](./2026-10-30-webui-provider-single-source-design.md)
- [webui theme persistence](./2026-10-30-webui-theme-persistence-design.md)
- [live data grounding guidance](./2026-10-31-live-data-grounding-guidance-design.md)
- [token speed](./2026-10-31-token-speed-design.md)
- [webui sounds](./2026-10-31-webui-sounds-design.md)
- [approve token](./2026-11-01-approve-token-design.md)
- [compaction history capacity](./2026-11-01-compaction-history-capacity-design.md)
- [document source bytes](./2026-11-01-document-source-bytes-design.md)
- [experts model selection](./2026-11-01-experts-model-selection-design.md)
- [LSP pool recovery](./2026-11-01-lsp-pool-recovery-design.md)
- [DLP transparency and coverage](./2026-11-02-dlp-transparency-and-coverage-design.md)
- [local provider taint](./2026-11-02-local-provider-taint-design.md)
- [subagent scope entries](./2026-11-02-subagent-scope-entries-design.md)
- [critic evidence provenance](./2026-11-03-critic-evidence-provenance-design.md)
- [final typecheck gate](./2026-11-03-final-typecheck-gate-design.md)
- [language adapters](./2026-11-03-language-adapters-design.md)
- [loopback web access](./2026-11-03-loopback-web-access-design.md)
- [memory validator](./2026-11-03-memory-validator-design.md)
- [pre-write check](./2026-11-03-pre-write-check-design.md)
- [skill usage top](./2026-11-03-skill-usage-top-design.md)
- [web build gate](./2026-11-03-web-build-gate-design.md)
- [webui latency](./2026-11-04-webui-latency-design.md)
