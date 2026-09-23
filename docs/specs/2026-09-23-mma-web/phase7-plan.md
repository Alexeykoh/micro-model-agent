# MMA Web — Phase 7 Plan: Settings & responsiveness fixes

> **For agentic workers:** implement task-by-task; each task ends with green `bun test` + `tsc --noEmit`. Canonical UI: [`mockups/layout-v6.html`](./mockups/layout-v6.html), [`docs/design/ui/STYLE.md`](../../design/ui/STYLE.md).

**Problems reported:** settings modal not adaptive (skills list overlaps/cramped); Memory page unreadable (raw markdown, unclear actions); UI/Theme rows show meaningless `—`; `version` appears editable; `logLevel` has no localized names; Security panel is a one-line placeholder; Plugins·MCP has no management; Model & Provider lacks add/edit; General not localized.

## Task A — Responsive settings modal + lists + memory clarity
- Modal: responsive width/height (`min(…, 92vw/88vh)`), content scrolls, left menu collapses/wraps on narrow screens; rows wrap (`flex-wrap`, min-width 0) so long values don't overlap.
- Skills/Plugins lists: wrap text, no fixed-height overlap, ellipsize long paths with `title`.
- Memory page: render entries as readable blocks (strip/format raw `**…**` markdown → plain text or light formatting), clear category headers with counts, per-entry `forget` action, add-entry row usable, empty states.
- General layout: chat/sidebar/input adapt on narrow widths (sidebar collapses, topbar tabs scroll).

## Task B — Settings labels, enums, read-only, UI/Security pages
- **Localized config labels:** add `config.key.<key>` (en+ru) for all registry keys; `renderGenericPanel` uses `t("config.key." + key)` instead of the raw key. Add `config.enum.<value>` (en+ru) for enum values (`logLevel`, `ui.verbosity`, `reasoning.mode`, `locale`).
- **`version` read-only:** ensure it renders as a non-editable value (registry already `readOnly:true`; verify the UI honors it and doesn't show an input).
- **UI & Theme panel:** replace meaningless `—` rows with real controls where the config supports them (font size / animations / stream partials only if config keys exist; otherwise remove the dead rows and keep theme + verbosity-related UI).
- **Security panel:** render real controls. Add registry keys for the safe, high-value security toggles (`security.enabled`, `security.paths.enabled`, `security.contentScan.enabled`, `security.sessionEncryption.enabled`, …) with proper getters/setters, and render them; show the web token (env, read-only, masked) and a short note about terminal-wizard-only options.

## Task C — Plugins·MCP management + Provider add/edit
- **Plugins·MCP:** show name/version/source/status clearly; add enable/disable if a config-backed mechanism exists (e.g. `plugins.disabled` list) — otherwise present status + an explicit note, and improve layout. MCP: show configured servers with status.
- **Model & Provider:** add a provider add/edit popup (type/label/baseUrl/apiKey/contextWindow/priority/rpm/parallel) → new `POST /api/providers` (add/update) + `DELETE /api/providers/:name`; edit active provider settings; select active provider/model. Redact secrets on read.

## Task D — Verify + docs
- Full gates, manual side-by-side with the mockup, update CHANGELOG/AGENTS if needed, append findings to `report.md`.
