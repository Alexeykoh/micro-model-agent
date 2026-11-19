# Settings IA gaps fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every key listed in the Security settings panel actually editable in `mma web` — render the orphaned `security.scan` section and add registry definitions for the four HITL/compliance keys.

**Architecture:** Two independent defects in `v0_26_0`. (1) `PANEL_SECTIONS.security` contains a `security.scan` section, but `panels-security.ts` maps only a subset of section ids into its subtab `TABS`, so that section is never rendered. (2) `security.approvals` is rendered but lists `hitl.*`/`compliance.*` keys that have no `ConfigKeyDef`, so `defFor()` returns `null` and the section is empty. Fix (1) by adding the section id to an existing subtab; fix (2) by declaring the four keys in the central registry (the config fields and defaults already exist and are read by runtime code). No contract/spec change: these are existing config fields, no new config schema keys.

**Tech Stack:** Bun + TypeScript, vitest-compatible Bun test runner, happy-dom frontend tests, Biome lint, `bun run quality`.

---

## File structure

- `src/modules/webui/assets/js/settings/panels-security.ts` — subtab → section mapping; add `security.scan` to the `shell` tab list.
- `src/config/registry-extra-security.ts` — Security group of config key definitions; add four defs (`bool` × 3? no: `bool` × 3, `int` × 1).
- `src/i18n/en.json`, `src/i18n/ru.json` — add three missing `config.key.*` labels (`hitl.autoApproveLow`, `compliance.enabled`, `compliance.retentionDays`); `hitl.killSwitch` label/description already exist.
- `tests/webui-settings-ia.test.ts` — two regression guards: every Security section id is reachable from a subtab, and every Security panel key has a registry definition.
- `docs/agents/settings-inventory-v0_26_0.md` — append a short post-fix note (the report is a snapshot of the unpatched tag).

---

### Task 1: Guard + fix the orphaned `security.scan` section

**Files:**
- Modify: `tests/webui-settings-ia.test.ts`
- Modify: `src/modules/webui/assets/js/settings/panels-security.ts:10-25`

- [ ] **Step 1: Write the failing test**

Append to `describe("settings IA", ...)` in `tests/webui-settings-ia.test.ts`. Add the file read at the top next to the existing imports:

```ts
const securityPanel = readFileSync(
  new URL(
    "../src/modules/webui/assets/js/settings/panels-security.ts",
    import.meta.url,
  ),
  "utf8",
);
```

Then add this test:

```ts
it("renders every Security section in at least one subtab", () => {
  const tabBlock = securityPanel.match(/const TABS[\s\S]*?\];/)?.[0] ?? "";
  const listed = new Set(
    [...tabBlock.matchAll(/"(security\.[a-zA-Z.]+)"/g)].map((m) => m[1]),
  );
  const sections = (PANEL_SECTIONS.security as Array<{ id: string }>).map(
    (s) => s.id,
  );
  const orphaned = sections.filter((id) => !listed.has(id));
  expect(orphaned).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails for the right reason**

Run: `bun test tests/webui-settings-ia.test.ts`
Expected: FAIL with `orphaned` containing `"security.scan"` (not an import/syntax error).

- [ ] **Step 3: Minimal implementation**

In `src/modules/webui/assets/js/settings/panels-security.ts`, change the `shell` entry from:

```ts
  ["shell", "web.settings.tab_security_shell", ["security.bash", "security.paths"]],
```

to:

```ts
  [
    "shell",
    "web.settings.tab_security_shell",
    ["security.bash", "security.paths", "security.scan"],
  ],
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/webui-settings-ia.test.ts`
Expected: all tests pass; no other failures.

- [ ] **Step 5: Commit**

```bash
git add tests/webui-settings-ia.test.ts src/modules/webui/assets/js/settings/panels-security.ts
git commit -m "fix(webui): render content-scan patterns in Security shell tab"
```

---

### Task 2: Guard + fix missing HITL/compliance registry definitions

**Files:**
- Modify: `tests/webui-settings-ia.test.ts`
- Modify: `src/config/registry-extra-security.ts`
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`

- [ ] **Step 1: Write the failing test**

Add to the top of `tests/webui-settings-ia.test.ts`, next to the existing imports:

```ts
const { resolveConfigKey } = await import("../src/config/registry.ts");
```

Append this test to `describe("settings IA", ...)`:

```ts
it("has a registry definition for every Security panel key", () => {
  const missing = keysOf("security").filter(
    (key) => resolveConfigKey(key) === null,
  );
  expect(missing).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails for the right reason**

Run: `bun test tests/webui-settings-ia.test.ts`
Expected: FAIL with `missing` equal to:

```
["hitl.killSwitch", "hitl.autoApproveLow", "compliance.enabled", "compliance.retentionDays"]
```

- [ ] **Step 3: Minimal implementation — registry defs**

In `src/config/registry-extra-security.ts`, add `DEFAULTS` to the existing import from `./defaults` style (the file currently imports `DEFAULT_SECURITY_CONFIG` from `./security`; add a second import):

```ts
import { DEFAULTS } from "./defaults";
```

Append four entries at the end of the `SECURITY_EXTRA_DEFS` array (before the closing `];`):

```ts
  bool("hitl.killSwitch", "hitl", false,
    (c) => c.hitl?.killSwitch ?? DEFAULTS.hitl!.killSwitch!,
    (c, v) => { c.hitl ??= structuredClone(DEFAULTS.hitl!); c.hitl.killSwitch = v as boolean; }),
  bool("hitl.autoApproveLow", "hitl", false,
    (c) => c.hitl?.autoApproveLow ?? DEFAULTS.hitl!.autoApproveLow!,
    (c, v) => { c.hitl ??= structuredClone(DEFAULTS.hitl!); c.hitl.autoApproveLow = v as boolean; }),
  bool("compliance.enabled", "compliance", false,
    (c) => c.compliance?.enabled ?? DEFAULTS.compliance!.enabled!,
    (c, v) => { c.compliance ??= structuredClone(DEFAULTS.compliance!); c.compliance.enabled = v as boolean; }),
  int("compliance.retentionDays", "compliance", 1, 3650, 1, false,
    (c) => c.compliance?.retentionDays ?? DEFAULTS.compliance!.retentionDays!,
    (c, v) => { c.compliance ??= structuredClone(DEFAULTS.compliance!); c.compliance.retentionDays = v as number; }),
```

`bool` and `int` are already imported from `./registry-extra-factories`; no new imports besides `DEFAULTS`.

- [ ] **Step 4: Add i18n labels**

In `src/i18n/en.json` and `src/i18n/ru.json`, insert these lines next to the existing `"config.key.hitl.killSwitch"` entries (both files, same key set — `tests/i18n.test.ts` enforces parity).

`en.json`:

```json
  "config.key.hitl.autoApproveLow": "auto-approve low-impact actions",
  "config.key.compliance.enabled": "compliance trail",
  "config.key.compliance.retentionDays": "compliance retention, days",
```

`ru.json`:

```json
  "config.key.hitl.autoApproveLow": "авто-одобрение действий низкого риска",
  "config.key.compliance.enabled": "журнал соответствия",
  "config.key.compliance.retentionDays": "хранение журнала, дней",
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/webui-settings-ia.test.ts tests/i18n.test.ts tests/webui-i18n.test.ts`
Expected: all pass; no missing-label failures.

- [ ] **Step 6: Commit**

```bash
git add tests/webui-settings-ia.test.ts src/config/registry-extra-security.ts src/i18n/en.json src/i18n/ru.json
git commit -m "fix(config): register HITL/compliance keys so Security approvals render"
```

---

### Task 3: Live verification on the Docker stand and final gates

**Files:**
- Modify: `docs/agents/settings-inventory-v0_26_0.md` (append a post-fix note only)

- [ ] **Step 1: Run the focused tests**

Run: `bun test tests/webui-settings-ia.test.ts tests/i18n.test.ts tests/webui-i18n.test.ts tests/docs-link-check.test.ts`

Expected: 0 failures.

- [ ] **Step 2: Run the full gates**

Run: `bun test` then `bun run quality`.
Expected: both green. If the full suite is too slow, run `bun test` with a generous timeout; never report success without reading the final summary.

- [ ] **Step 3: Live check in mma web**

Rebuild/restart the `mma-web-test` container so it serves the patched sources, open the settings modal, and verify in the browser:
- Security → «Shell и пути» contains the «Сканирование содержимого файлов» section with the «опасные паттерны» chip editor;
- Security → «Аудит» → «Согласования и compliance» now contains four controls instead of an empty card;
- toggling each new control changes `GET /api/config` and survives a reload.

- [ ] **Step 4: Append a post-fix note to the inventory report**

Append to `docs/agents/settings-inventory-v0_26_0.md`:

```markdown
## Post-fix note (2026-11-19)

The two N/A findings (`security.contentScan.dangerousPatterns` and the empty
HITL/compliance section) were fixed after this snapshot in branch
`fix/settings-ia-gaps`: the content-scan section is now mapped to the Security
"Shell and paths" subtab, and the four HITL/compliance keys have registry
definitions and are editable in `mma web`. The 199/200-key counts above describe
the unpatched `v0_26_0` tag.
```

- [ ] **Step 5: Commit the note**

```bash
git add docs/agents/settings-inventory-v0_26_0.md
git commit -m "docs: note post-fix state of the settings inventory"
```

---

## Self-review

- **Spec coverage:** defect 1 (orphan section) → Task 1; defect 2 (missing keys) → Task 2; evidence and regression guards → Tasks 1–2; verification → Task 3. No gap.
- **Placeholders:** none; every code step contains literal code.
- **Type consistency:** `resolveConfigKey`, `PANEL_SECTIONS`, `SECURITY_EXTRA_DEFS`, `bool`, `int`, `DEFAULTS` all exist at the paths used. `config.key.*` label keys are added symmetrically to both dictionaries.
