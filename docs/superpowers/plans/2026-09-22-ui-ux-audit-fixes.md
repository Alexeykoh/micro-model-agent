# UI/UX Audit Fixes (#3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five UX defects found in the first-run/config audit: inverted security-paths answer, first-run wizard suppression by subcommands/one-shot, `/wizard` dropping security answers and ignoring `provider.entries[]`, `mma config show` leaking secrets, and Tab completion lacking descriptions/navigation/path support.

**Architecture:** Each defect is fixed at its root: security answers normalized in `SetupAnswers`/`applyAnswersToConfig`; first-run detection moved to a non-persisting config load; `/wizard` reuses the first-run apply path; a recursive `redactConfigSecrets` sanitizes `config show`; the completer returns `CompletionItem`s rendered with descriptions, registers file paths, and gains an arrow-key menu.

**Tech Stack:** Bun + TypeScript (ES2022, NodeNext), `bun:test`, i18n en/ru parity required.

---

## Scope & ordering

This plan is independent of the model-picker work and can branch from `master`. Suggested split if too large: **Part 1–4 are small and independent; Part 5 (Tab UX) is a separate feature** — implement Part 5 last.

**Design decisions (locked):**
- Security-paths question is reworded to **restrict** semantics (default: restrict).
- `security.paths.enabled` becomes the switch the wizard actually sets.
- `loadConfig` no longer writes files on first load; only explicit `saveConfig` persists.
- One-shot runs on a virgin machine **warn** and proceed with defaults (they do not run the wizard).
- `config show` redacts by default; `--show-secrets` opts out.
- `/config set` is **not** added; the dead `ConfigKeyProvider` is removed.
- Tab: single match completes; multiple matches render `value  description` and support arrow-key selection.

---

# PART 1 — Security paths question (inverted + no-op)

### Task 1.1: Rename the answer field and fix the question semantics

**Files:**
- Modify: `src/cli/setup.ts:9-20` (interface), `:241-253` (block)
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`

- [ ] **Step 1: Update `SetupAnswers`**

In `src/cli/setup.ts` replace `securityPathsDeny: boolean;` with:
```ts
  securityPathsRestrict: boolean;
```

- [ ] **Step 2: Fix the question block**

Replace lines 241-253 (from `// Security settings` through the closing `}` of the `if`) with:
```ts
  // Security settings
  getDefaultChannel().writeLine(t("setup.security_header"));
  getDefaultChannel().writeLine(pc.dim(t("setup.security_status_on")));
  const configureSecurity = await ask(rl, t("setup.security_configure"), "n");
  let securityBashBlock = false;
  let securityFlagsBlock = false;
  let securityPathsRestrict = true;
  if (configureSecurity.toLowerCase() === "y" || configureSecurity.toLowerCase() === "yes") {
    securityBashBlock = (await ask(rl, t("setup.security_bash_block"), "n")).toLowerCase() === "y";
    securityFlagsBlock =
      (await ask(rl, t("setup.security_flags_block"), "n")).toLowerCase() === "y";
    securityPathsRestrict =
      (await ask(rl, t("setup.security_paths_restrict"), "Y")).toLowerCase() !== "n";
  }
```

- [ ] **Step 3: Update the answers object and summary**

In the `answers` object replace `securityPathsDeny,` with `securityPathsRestrict,`. (No summary line changes.)

- [ ] **Step 4: i18n — replace the key**

In `src/i18n/en.json` remove `"setup.security_paths_deny"` and add:
```json
  "setup.security_paths_restrict": "  Restrict access to .git/, .env, node_modules/? (Y/n)",
```
In `src/i18n/ru.json` remove `"setup.security_paths_deny"` and add:
```json
  "setup.security_paths_restrict": "  Ограничить доступ к .git/, .env, node_modules/? (Y/n)",
```

- [ ] **Step 5: Run setup-related tests**
Run: `bun test tests/cli/main-first-run.test.ts`
Expected: FAIL to compile (field renamed) — continue to Task 1.2 which updates the consumer, then re-run.

### Task 1.2: Apply the answer to `security.paths.enabled`

**Files:**
- Modify: `src/cli/setup-order.ts:36-59`
- Test: `tests/cli/main-first-run.test.ts`

- [ ] **Step 1: Update `applyAnswersToConfig`**

Replace the security block at the end of `applyAnswersToConfig`:
```ts
    if (!a.securityPathsDeny) config.security.paths.denied = [];
```
with:
```ts
    config.security.paths.enabled = a.securityPathsRestrict;
    if (!a.securityPathsRestrict) config.security.paths.denied = [];
```

- [ ] **Step 2: Update existing tests**

In `tests/cli/main-first-run.test.ts`, replace every `securityPathsDeny: true` with `securityPathsRestrict: true` and `securityPathsDeny: false` with `securityPathsRestrict: false`. Update assertions:
- where the test asserted `paths.denied` is cleared for `false`, assert `paths.enabled === false`.
- add a case: `securityPathsRestrict: true` → `paths.enabled === true` and `paths.denied` non-empty.

- [ ] **Step 3: Run**
Run: `bun test tests/cli/main-first-run.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**
```bash
git add src/cli/setup.ts src/cli/setup-order.ts src/i18n/en.json src/i18n/ru.json tests/cli/main-first-run.test.ts
git commit -m "fix(setup): correct inverted security-paths answer and enable path policy"
```

### Task 1.3: Make `mma init` reuse the shared apply logic

**Files:**
- Modify: `src/cli/commands.ts:33-79`

- [ ] **Step 1: Replace the inline security block**

Delete the inline `SECURITY_BASH_BLOCKLIST`-equivalent block (the `if (config.security) { … }` region) in `mma init` and instead call the shared applier after setting the provider/model/locale fields is no longer needed either — replace the whole action body from `config.provider.type = answers.provider;` through the end of the security block with:
```ts
      const { config, configDir } = await bootstrap();
      const configPath = join(configDir, "config.json");
      applyAnswersToConfig(config, answers);
```
Add the import at the top of `src/cli/commands.ts`:
```ts
import { applyAnswersToConfig } from "./setup-order";
```
(Keep `runSetup()` and the `saveConfig`/message lines unchanged.)

- [ ] **Step 2: Typecheck + tests**
Run: `bunx tsc --noEmit` and `bun test tests/cli/`
Expected: PASS.

- [ ] **Step 3: Commit**
```bash
git add src/cli/commands.ts
git commit -m "refactor(cli): mma init reuses applyAnswersToConfig"
```

---

# PART 2 — First run suppressed by subcommands / one-shot

**Root cause:** `loadConfig` writes default domain files when none exist (`src/config/config.ts:304-307`), so any subcommand or one-shot run creates a config and the next interactive `mma` skips the wizard.

### Task 2.1: Stop `loadConfig` from persisting defaults

**Files:**
- Modify: `src/config/config.ts:304-307`
- Test: `tests/config-domains.test.ts:259`

- [ ] **Step 1: Update the failing test**

In `tests/config-domains.test.ts`, change the test at ~line 259:
```ts
  it("first run: creates domain files, returns defaults", () => {
```
to:
```ts
  it("first run: returns defaults without creating files", () => {
```
and change the assertion `expect(hasDomainFiles(tmpDir)).toBe(true);` (the one inside this test, ~line 268) to `expect(hasDomainFiles(tmpDir)).toBe(false);`. Keep the "returns defaults" assertions.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/config-domains.test.ts`
Expected: FAIL — `hasDomainFiles` is true.

- [ ] **Step 3: Remove the auto-create step**

In `src/config/config.ts` delete:
```ts
  // Step 3: first run — auto-create domain files instead of config.json
  if (!globalData && !domainConfig) {
    saveDomainFiles(config, options.configDir);
  }
```
and update the subsequent comments/step numbering if needed. If `saveDomainFiles` becomes an unused import in `config.ts`, remove it from the import (verify with `rg -n 'saveDomainFiles' src/config/config.ts`).

- [ ] **Step 4: Run config tests**

Run: `bun test tests/config-domains.test.ts tests/config.test.ts tests/config/`
Expected: PASS. If another test depended on auto-create, update it to seed files via `saveDomainFiles` explicitly, or assert the new behavior.

- [ ] **Step 5: Commit**
```bash
git add src/config/config.ts tests/config-domains.test.ts
git commit -m "fix(config): do not persist default config on first load"
```

### Task 2.2: Warn (don't silently default) on first-run one-shot

**Files:**
- Modify: `src/cli/main.ts:125-155`
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`

- [ ] **Step 1: Detect first run in the one-shot branch**

In `src/cli/main.ts`, inside `if (program.args.length > 0) {` right after `const prompt = program.args.join(" ");` (line 139), add:
```ts
    const mmaDir = process.env.MMA_CONFIG_DIR || join(homedir(), ".mma");
    const { hasDomainFiles } = await import("../config/domains");
    const virgin = !existsSync(join(mmaDir, "config.json")) && !hasDomainFiles(mmaDir);
```
Then, immediately after `if (legacyDetected) { … }` (line 155), add:
```ts
    if (virgin && !jsonOpt) {
      getDefaultChannel().writeLine(pc.yellow(`  ${t("cli.first_run_oneshot")}`), "stderr");
    }
```
(Confirm `existsSync`, `join`, `homedir` are already imported in `main.ts`; add imports if missing.)

- [ ] **Step 2: i18n**

Add to `src/i18n/en.json`:
```json
  "cli.first_run_oneshot": "No configuration found — running with defaults. Run `mma` (no arguments) once to set up the wizard.",
```
`src/i18n/ru.json`:
```json
  "cli.first_run_oneshot": "Конфигурация не найдена — запуск с настройками по умолчанию. Запустите `mma` без аргументов один раз для настройки.",
```

- [ ] **Step 3: Typecheck + JSON + parity**
Run: `bunx tsc --noEmit`; validate both JSON; confirm equal key counts.

- [ ] **Step 4: Commit**
```bash
git add src/cli/main.ts src/i18n/en.json src/i18n/ru.json
git commit -m "fix(cli): warn on first-run one-shot without config"
```

### Task 2.3: Verify subcommands no longer suppress the wizard

- [ ] **Step 1: Sandbox check**

```powershell
$env:MMA_CONFIG_DIR="$env:TEMP\mma-virgin"; Remove-Item -Recurse -Force "$env:TEMP\mma-virgin" -ErrorAction SilentlyContinue
bun run mma config show > $null
Test-Path "$env:TEMP\mma-virgin\config"   # expect False
```
Expected: `False` — no domain files created. Then a subsequent interactive `bun run mma` on the same sandbox would enter the wizard (manual confirmation).

---

# PART 3 — `/wizard` drops security answers and ignores `entries[]`

### Task 3.1: Reuse `applyAnswersToConfig`, handle multi-entry

**Files:**
- Modify: `src/cli/repl-commands.ts:315-337`

- [ ] **Step 1: Replace the `/wizard` action body**

Replace:
```ts
        const answers = await runSetup(ctx.rl);
        const configPath = join(ctx.configDir, "config.json");
        ctx.config.provider.type = answers.provider;
        ctx.config.provider.baseUrl = answers.apiBase;
        ctx.config.provider.apiKey = answers.apiKey;
        ctx.config.model = answers.model;
        ctx.config.contextWindow = answers.contextWindow;
        ctx.config.maxToolIterations = answers.maxToolIterations;
        ctx.config.locale = answers.locale;
        saveConfig(ctx.config, configPath, dirname(configPath));
        await ctx.agent.reconfigure(ctx.config);
        ctx.output.writeLine(pc.green(t("cli.config_saved")));
```
with:
```ts
        const answers = await runSetup(ctx.rl);
        const configPath = join(ctx.configDir, "config.json");
        // Multi-entry configs resolve the active provider from `entries[]`, so
        // a fresh single entry must replace them for the wizard choice to win.
        const hadEntries = (ctx.config.provider.entries?.length ?? 0) > 0;
        applyAnswersToConfig(ctx.config, answers);
        if (hadEntries) {
          ctx.config.provider.entries = [
            {
              type: answers.provider,
              label: answers.provider,
              baseUrl: answers.apiBase,
              apiKey: answers.apiKey,
            },
          ];
          ctx.config.provider.active = answers.provider;
        }
        saveConfig(ctx.config, configPath, dirname(configPath));
        await ctx.agent.reconfigure(ctx.config);
        ctx.output.writeLine(pc.green(t("cli.config_saved")));
```
Add the import at the top of `src/cli/repl-commands.ts`:
```ts
import { applyAnswersToConfig } from "./setup-order";
```

- [ ] **Step 2: Typecheck + tests**
Run: `bunx tsc --noEmit`; `bun test tests/cli/`
Expected: PASS.

- [ ] **Step 3: Commit**
```bash
git add src/cli/repl-commands.ts
git commit -m "fix(repl): /wizard applies security answers and provider entries"
```

---

# PART 4 — `mma config show` leaks secrets

### Task 4.1: Add a recursive config redactor

**Files:**
- Create: `src/config/redact.ts`
- Test: `tests/config/redact.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/config/redact.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import { redactConfigSecrets } from "../../src/config/redact";

describe("redactConfigSecrets", () => {
  it("redacts provider api keys", () => {
    const input = { provider: { type: "openai-compat", apiKey: "sk-secret" } };
    const out = redactConfigSecrets(input) as any;
    expect(out.provider.apiKey).toBe("***");
  });

  it("redacts nested entry api keys", () => {
    const input = {
      provider: { entries: [{ label: "a", apiKey: "k1" }, { label: "b", apiKey: "k2" }] },
    };
    const out = redactConfigSecrets(input) as any;
    expect(out.provider.entries[0].apiKey).toBe("***");
    expect(out.provider.entries[1].apiKey).toBe("***");
  });

  it("redacts mcp header values", () => {
    const input = { mcpServers: { s: { headers: { Authorization: "Bearer x" } } } };
    const out = redactConfigSecrets(input) as any;
    expect(out.mcpServers.s.headers.Authorization).toBe("***");
  });

  it("redacts webhook urls", () => {
    const input = { security: { audit: { webhookUrl: "https://hook/secret" } } };
    const out = redactConfigSecrets(input) as any;
    expect(out.security.audit.webhookUrl).toBe("***");
  });

  it("leaves non-secret values intact", () => {
    const input = { model: "qwen/qwen3.5-9b", contextWindow: 32768, maxTokens: 4096 };
    expect(redactConfigSecrets(input)).toEqual(input);
  });

  it("does not mutate the input", () => {
    const input = { provider: { apiKey: "sk-x" } };
    redactConfigSecrets(input);
    expect((input as any).provider.apiKey).toBe("sk-x");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/config/redact.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/config/redact.ts`:
```ts
/** Keys whose string values are secrets and must be masked on display. */
const SECRET_KEYS = new Set([
  "apiKey",
  "api_key",
  "apikey",
  "token",
  "secret",
  "password",
  "authorization",
  "webhookUrl",
]);

/** Object-valued keys whose every value is sensitive (header/env maps). */
const SECRET_MAPS = new Set(["headers", "env"]);

const MASK = "***";

function redactValue(key: string, value: unknown): unknown {
  if (SECRET_MAPS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>)) out[k] = MASK;
    return out;
  }
  if (typeof value === "string" && SECRET_KEYS.has(key)) return MASK;
  return redactConfigSecrets_inner(value);
}

function redactConfigSecrets_inner(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactConfigSecrets_inner(v));
  if (value && typeof value === "object" && !(value instanceof RegExp)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(k, v);
    }
    return out;
  }
  return value;
}

/** Return a deep copy of `config` with secret values replaced by `***`. */
export function redactConfigSecrets<T>(config: T): T {
  return redactConfigSecrets_inner(config) as T;
}
```

- [ ] **Step 4: Run**
Run: `bun test tests/config/redact.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**
```bash
git add src/config/redact.ts tests/config/redact.test.ts
git commit -m "feat(config): add redactConfigSecrets helper"
```

### Task 4.2: Redact `mma config show` by default

**Files:**
- Modify: `src/cli/commands.ts:109-115`
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`

- [ ] **Step 1: Add the option and redaction**

Replace the `config show` command with:
```ts
  configCmd
    .command("show")
    .description(t("cli.show_config"))
    .option("--show-secrets", "Print secrets (API keys, tokens) unredacted")
    .action(async (opts: { showSecrets?: boolean }) => {
      const { config } = await bootstrap();
      const { redactConfigSecrets } = await import("../config/redact");
      writeMachineJson(opts.showSecrets ? config : redactConfigSecrets(config));
    });
```

- [ ] **Step 2: i18n**

Add to `src/i18n/en.json`:
```json
  "cli.show_config": "Show the effective configuration (secrets redacted; use --show-secrets to reveal)",
```
`src/i18n/ru.json`:
```json
  "cli.show_config": "Показать действующую конфигурацию (секреты скрыты; используйте --show-secrets)",
```
(The existing `cli.show_config` key is replaced, not duplicated.)

- [ ] **Step 3: Typecheck + tests**
Run: `bunx tsc --noEmit`; `bun test tests/cli/commands.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**
```bash
git add src/cli/commands.ts src/i18n/en.json src/i18n/ru.json
git commit -m "fix(cli): redact secrets in mma config show by default"
```

---

# PART 5 — Tab completion: descriptions, path completion, arrow navigation

### Task 5.1: Introduce `CompletionItem` and return descriptions

**Files:**
- Modify: `src/cli/completer.ts`
- Test: `tests/cli/completer.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create/extend `tests/cli/completer.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import { Completer, SlashCommandProvider } from "../../src/cli/completer";

describe("Completer descriptions", () => {
  it("returns value + description for slash commands", () => {
    const c = new Completer();
    c.registerProvider(
      new SlashCommandProvider([
        { name: "help", description: "Show help" },
        { name: "model", description: "Model commands" },
      ]),
    );
    const [items] = c.complete("/he");
    expect(items).toEqual([{ value: "/help", description: "Show help" }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/cli/completer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `CompletionItem`**

In `src/cli/completer.ts` add:
```ts
export interface CompletionItem {
  value: string;
  description?: string;
}
```
Change `CompletionProvider.complete` to return `CompletionItem[]` and `Completer.complete` to return `[CompletionItem[], string]`. Update every provider:
- `SlashCommandProvider` constructor takes `Array<{ name: string; description?: string }>` and returns `{ value: "/" + name, description }`.
- `SubcommandProvider` takes `Array<{ name: string; description?: string }>` (or keep `string[]` and map to `{ value }`).
- `ModelArgProvider`, `ProviderArgProvider`, `SessionNameProvider`, `SkillNameProvider`, `FilePathProvider` return `matches.map((m) => ({ value: m }))`.

- [ ] **Step 4: Update callers**

`src/cli/repl.ts` `editorCompleter` currently maps `[matches, partial]` straight through; adapt it to the new item shape (it can pass items through unchanged, since the LineEditor will render them).

- [ ] **Step 5: Run**
Run: `bun test tests/cli/completer.test.ts tests/cli/completer-provider.test.ts tests/cli/completer-filepath.test.ts`
Expected: PASS (update assertions in existing tests to the `{ value }` shape as needed).

- [ ] **Step 6: Commit**
```bash
git add src/cli/completer.ts src/cli/repl.ts tests/cli/completer*.test.ts
git commit -m "feat(cli): completer returns value+description items"
```

### Task 5.2: Render descriptions in the Tab list

**Files:**
- Modify: `src/ui/line-editor.ts:13-22` (completer signature), `:829-864` (tabComplete)

- [ ] **Step 1: Widen the completer type**

In `LineEditorOptions.completer` and `LineEditor.completer`, change the return type to `[Array<{ value: string; description?: string }>, string]`. (Import the type or declare it inline to avoid a UI→CLI dependency.)

- [ ] **Step 2: Render descriptions**

Replace the multi-match rendering in `tabComplete`:
```ts
    const rows = matches.map((m) => "  " + m);
```
with:
```ts
    const rows = matches.map((m) =>
      m.description ? `  ${m.value}  ${pc.dim(m.description)}` : `  ${m.value}`,
    );
```
(Import `pc` from `./colors` if not already; otherwise use the existing color helper in this file.)

- [ ] **Step 3: Single-match path**

Update the single-match branch to use `matches[0].value` where it previously used `matches[0]`.

- [ ] **Step 4: Typecheck + tests**
Run: `bunx tsc --noEmit`; `bun test tests/ui/ tests/cli/`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/ui/line-editor.ts
git commit -m "feat(ui): show descriptions in tab-completion list"
```

### Task 5.3: Register file-path completion; remove dead `ConfigKeyProvider`

**Files:**
- Modify: `src/cli/repl.ts:351-378` (`setupCompleter`)
- Modify: `src/cli/completer.ts` (`FilePathProvider` cwd option; delete `ConfigKeyProvider`)
- Test: `tests/cli/completer-filepath.test.ts`

- [ ] **Step 1: Give `FilePathProvider` an explicit root**

Change its constructor to accept `root?: string` and use `root ?? process.cwd()` instead of `process.cwd()`. This makes it testable and lets the REPL pass `baseDir`.

- [ ] **Step 2: Register it in the REPL**

In `src/cli/repl.ts` `setupCompleter`, after the slash/subcommand providers, add:
```ts
    this.completer.registerProvider(new FilePathProvider(this.baseDir));
```
and add `FilePathProvider` to the import from `./completer`.

- [ ] **Step 3: Remove `ConfigKeyProvider`**

Delete the `ConfigKeyProvider` class from `src/cli/completer.ts` (it matches a `/config set` command that does not exist). Verify no references: `rg -n 'ConfigKeyProvider' src/ tests/`.

- [ ] **Step 4: Typecheck + tests**
Run: `bunx tsc --noEmit`; `bun test tests/cli/`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/cli/completer.ts src/cli/repl.ts
git commit -m "feat(cli): register file-path completion, drop dead config-key provider"
```

### Task 5.4: Arrow-key completion menu

**Files:**
- Modify: `src/ui/line-editor.ts`
- Test: `tests/ui/line-editor-completion.test.ts` (create)

**Design:** After `tabComplete` with >1 match, enter a menu mode: the editor prints the item list once with the first item highlighted; `↑`/`↓` move the highlight, `Enter` accepts, `Esc`/`Tab` dismisses, any printable char leaves the menu and inserts the char. This is raw-mode state on the editor; no new dependency.

- [ ] **Step 1: Write the failing test**

Create `tests/ui/line-editor-completion.test.ts` driving `onKey` with synthetic keypresses (mirroring the existing `tests/ui/line-editor*.test.ts` patterns) and asserting: Tab opens the menu; `down` moves selection; `return` inserts the selected value; `escape` closes without inserting.

```ts
// Sketch — follow the existing line-editor test harness for constructing the editor.
it("selects a completion with arrow keys", () => {
  // editor.completer returns [{value:"aaa"},{value:"aab"},{value:"aac"}]
  // press tab -> menu open, selection index 0
  // press down -> index 1
  // press return -> buffer becomes "aab"
});
```

- [ ] **Step 2: Implement the menu state**

Add fields: `private completionMenu: { items: {value:string;description?:string}[]; index: number; line: string; from: number; partial: string } | null = null;`. In `onKey`, before normal handling, if `completionMenu` is active, intercept `up`/`down`/`return`/`escape`/`tab` and any printable input per the design, then `return`. In `tabComplete`, when `matches.length > 1`, store the menu state, print the list with the current item highlighted (reverse video or `>` marker), and do not return to normal typing until accepted/dismissed.

- [ ] **Step 3: Run**
Run: `bun test tests/ui/line-editor-completion.test.ts`
Expected: PASS.

- [ ] **Step 4: Full check**
Run: `bunx tsc --noEmit`; `bun test tests/ui/`; `bun test tests/cli/`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/ui/line-editor.ts tests/ui/line-editor-completion.test.ts
git commit -m "feat(ui): arrow-key navigation for tab completion"
```

---

## Final verification

- [ ] `bunx tsc --noEmit` → PASS.
- [ ] `bun test` → PASS.
- [ ] i18n en/ru key sets identical; JSON valid.
- [ ] Manual: virgin sandbox → `mma config show` creates no files, interactive `mma` still shows the wizard; `mma config show` masks `provider.apiKey`, `--show-secrets` reveals it; `/wizard` in a multi-entry session updates the active entry and applies security choices; Tab on a path completes and shows descriptions.

## Self-Review

- **Coverage:** inverted security-paths (1.1–1.3), first-run suppression (2.1–2.3), `/wizard` gaps (3.1), secret leak (4.1–4.2), Tab descriptions/paths/arrows (5.1–5.4).
- **Type consistency:** `securityPathsRestrict` used in `setup.ts` + `setup-order.ts`; `CompletionItem` used across `completer.ts` + `line-editor.ts` + `repl.ts`; `redactConfigSecrets` used in `commands.ts`.
- **Out of scope (explicit):** provider-use persistence on multi-entry configs, settings persistence for `/verbose`/`/reasoning`, `/locale`, `validateConfig` runtime wiring, and the remaining audit P1/P2 items not listed above.
