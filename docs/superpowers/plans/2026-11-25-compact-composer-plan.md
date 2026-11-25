# Compact Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five chip-like composer selectors with one quiet compact line (`llama.cpp / [heretic/38ts] ornith-1.5-9b-uncensored / ruler auto / brain auto`) that fits narrow windows, with semantic Lucide icons and preserved menus/accessibility.

**Architecture:** A small pure/DOM helper module owns compact label building, `/` separator visibility and tail-preserving model truncation. The existing selector renderers call it; no change to menu wiring, config funnel, session format or REST/SSE. CSS removes chip surfaces and adds the compact row; HTML adds separator spans and a hint toggle.

**Tech Stack:** Bun + TypeScript frontend (`src/modules/webui/assets/**`), `bun test` (vitest-compatible API), happy-dom for frontend DOM tests, Biome lint, `bun run quality`.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/modules/webui/assets/js/settings/selector-line.ts` | New: compact label builder, `tailLabel()`, separator sync, model fit installer. |
| `src/modules/webui/assets/js/settings/selectors-write.ts` | Use the new builder for model/context/reasoning; call separator sync + model fit. |
| `src/modules/webui/assets/js/settings/provider-selector.ts` | Use the new builder, keeping the real provider brand icon. |
| `src/modules/webui/assets/js/icons.ts` | Add Lucide `ruler`. |
| `src/modules/webui/assets/js/session/hint-toggle.ts` | New: `?` toggles the compact hint row. |
| `src/modules/webui/assets/app.ts` | Call `initHintToggle()` once during boot. |
| `src/modules/webui/assets/index.html` | Selector row with `/` separators, caps moved after reasoning, `hintMore` button. |
| `src/modules/webui/assets/styles.css` | Compact row CSS, hint CSS, phone/touch adjustments. |
| `docs/design/ui/STYLE.md` | Record `/` as the web-composer exception to `·`. |
| `tests/webui-compact-selector-line.test.ts` | New: helper unit tests. |
| `tests/webui-compact-line.test.ts` | New: static markup/CSS contract tests. |

---

### Task 1: Compact selector helpers + tests

**Files:**
- Create: `src/modules/webui/assets/js/settings/selector-line.ts`
- Test: `tests/webui-compact-selector-line.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/webui-compact-selector-line.test.ts
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const line = await import("../src/modules/webui/assets/js/settings/selector-line.js");

describe("compact selector line", () => {
  it("keeps the model tail when shortening", () => {
    expect(line.tailLabel("[heretic/38ts] ornith-1.5-9b-uncensored", 30)).toBe(
      "…ornith-1.5-9b-uncensored",
    );
  });

  it("does not shorten a value that fits", () => {
    expect(line.tailLabel("auto", 8)).toBe("auto");
  });

  it("keeps full label and value for assistive tech", () => {
    setupHappyDom();
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    line.setCompactLabel(btn, "модель", "[heretic/38ts] ornith-1.5-9b-uncensored");
    expect(btn.title).toBe("модель: [heretic/38ts] ornith-1.5-9b-uncensored");
    expect(btn.getAttribute("aria-label")).toBe(btn.title);
    expect(btn.dataset.value).toBe("[heretic/38ts] ornith-1.5-9b-uncensored");
    expect(btn.querySelector("b > span")?.textContent).toBe(
      "[heretic/38ts] ornith-1.5-9b-uncensored",
    );
    expect(btn.querySelectorAll("svg.svg-icon")).toHaveLength(1);
  });

  it("hides a separator next to a hidden selector", () => {
    setupHappyDom(`<div class="selectors">
      <div class="sel" data-sel="context"></div>
      <span class="selector-sep">/</span>
      <div class="sel" data-sel="reasoning" hidden></div>
    </div>`);
    line.syncSelectorSeparators(document);
    expect(document.querySelector<HTMLElement>(".selector-sep")?.hidden).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/webui-compact-selector-line.test.ts`
Expected: FAIL — module `selector-line.js` not found.

- [ ] **Step 3: Write the helper module**

```ts
// src/modules/webui/assets/js/settings/selector-line.ts
// Compact composer selector line: label building, `/` separators and
// tail-preserving model truncation. Chat status glyphs stay textual per
// docs/design/ui/STYLE.md; Lucide icons here are chrome only.
import { icon } from "../dom.js";

const observed = new WeakSet<HTMLElement>();

/** Shorten from the left, keeping the distinctive tail of a model name. */
export function tailLabel(value: string, maxChars: number): string {
  if (maxChars < 2 || value.length <= maxChars) return value;
  return "…" + value.slice(value.length - (maxChars - 1));
}

/** Build a chip-free selector button; full "label: value" stays in title/aria-label. */
export function setCompactLabel(
  btn: HTMLElement | null,
  label: string,
  value: string,
  leading?: SVGElement,
): void {
  if (!btn) return;
  btn.textContent = "";
  btn.title = label + ": " + value;
  btn.setAttribute("aria-label", btn.title);
  btn.dataset.value = value;
  if (leading) btn.appendChild(leading);
  const b = document.createElement("b");
  const span = document.createElement("span");
  span.dir = "ltr";
  span.textContent = value;
  b.appendChild(span);
  btn.appendChild(b);
  btn.appendChild(icon("chevron-down"));
}

/** Lucide chrome icon for a selector (context = ruler, reasoning = brain). */
export function leadingIcon(name: string): SVGElement {
  return icon(name);
}

/** A `/` is shown only when both neighbouring selectors are visible. */
export function syncSelectorSeparators(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>(".selector-sep").forEach((sep) => {
    const prev = sep.previousElementSibling as HTMLElement | null;
    const next = sep.nextElementSibling as HTMLElement | null;
    sep.hidden = !prev || !next || prev.hidden || next.hidden;
  });
}

/** Fit the model value into the available width without losing its tail. */
export function fitModelLabel(btn: HTMLElement | null): void {
  if (!btn) return;
  const b = btn.querySelector<HTMLElement>("b");
  const span = b?.querySelector<HTMLElement>("span");
  const full = btn.dataset.value || "";
  if (!b || !span || !full) return;
  const chars = Math.max(8, Math.floor((b.clientWidth || 240) / 7));
  const next = tailLabel(full, chars);
  if (span.textContent !== next) span.textContent = next;
}

/** Install the fit on the model button once; re-fit on every render + resize. */
export function installModelFit(root: ParentNode = document): void {
  const btn = root.querySelector<HTMLElement>('[data-sel="model"] button');
  if (!btn) return;
  const fit = () => fitModelLabel(btn);
  fit();
  if (observed.has(btn)) return;
  observed.add(btn);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(fit).observe(btn);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/webui-compact-selector-line.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/webui/assets/js/settings/selector-line.ts tests/webui-compact-selector-line.test.ts
git commit -m "feat(webui): compact selector line helpers with tail-preserving model label"
```

---

### Task 2: Wire selectors to the helpers

**Files:**
- Modify: `src/modules/webui/assets/js/icons.ts:243`
- Modify: `src/modules/webui/assets/js/settings/selectors-write.ts:6-34,69-73,151,169-173,239,247-259`
- Modify: `src/modules/webui/assets/js/settings/provider-selector.ts:3-30`
- Test: `tests/webui-compact-line.test.ts`

- [ ] **Step 1: Write the failing static contract test**

```ts
// tests/webui-compact-line.test.ts  (part 1 of 2)
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf-8");
const ICONS = read("../src/modules/webui/assets/js/icons.ts");
const WRITE = read("../src/modules/webui/assets/js/settings/selectors-write.ts");
const PROVIDER = read("../src/modules/webui/assets/js/settings/provider-selector.ts");

describe("compact selectors wiring", () => {
  it("adds the Lucide ruler icon", () => {
    expect(ICONS).toMatch(/\bruler:\s*\[/);
  });
  it("uses the shared builder instead of visible label prefixes", () => {
    expect(WRITE).toContain('from "./selector-line.js"');
    expect(WRITE).toContain("setCompactLabel(");
    expect(WRITE).not.toContain("btn.textContent = label + \":\"");
    expect(WRITE).toContain("leadingIcon(\"ruler\")");
  });
  it("keeps the provider brand icon", () => {
    expect(PROVIDER).toContain("providerIcon(active?.type, value)");
    expect(PROVIDER).toContain("setCompactLabel(");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/webui-compact-line.test.ts`
Expected: FAIL on `adds the Lucide ruler icon` (no `ruler` key yet).

- [ ] **Step 3: Add `ruler` to the icon table**

Insert before the closing `};` of `ICONS` in `src/modules/webui/assets/js/icons.ts`:

```ts
  // Compact composer: context window size.
  ruler: [
    ["path", { d: "M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.4 8.4a2.4 2.4 0 0 1 0-3.4l2.6-2.6a2.4 2.4 0 0 1 3.4 0z" }],
    ["path", { d: "m14.5 5.5 4 4" }],
    ["path", { d: "m11.5 8.5 4 4" }],
    ["path", { d: "m8.5 11.5 4 4" }],
    ["path", { d: "m5.5 14.5 4 4" }],
  ],
```

- [ ] **Step 4: Replace `setSelButton` in `selectors-write.ts`**

At the top, after the existing imports (near line 23), add:

```ts
import {
  setCompactLabel,
  syncSelectorSeparators,
  installModelFit,
  leadingIcon,
} from "./selector-line.js";
```

Delete the old `setSelButton()` function (lines 25-34). Replace each call:

```ts
// line 72
setCompactLabel(document.getElementById("selModelBtn"), t("web.selectors.model"), cfg.model || "—");

// line 151
// (provider button is rebuilt by renderProviderSelector — see next step)

// lines 169-173
setCompactLabel(
  document.getElementById("selContextBtn"),
  t("web.selectors.context"),
  auto ? t("web.selectors.auto") : contextLabel(),
  leadingIcon("ruler"),
);

// line 259
setCompactLabel(btn, t("web.selectors.reasoning"), String(mode), leadingIcon("brain"));
```

At the end of `renderSelectors()`, immediately before `paintSelectorPending();` (line 239), add:

```ts
  const selectorsRow = document.querySelector<HTMLElement>(".selectors");
  if (selectorsRow) syncSelectorSeparators(selectorsRow);
  installModelFit();
```

- [ ] **Step 5: Rebuild the provider button through the helper**

In `src/modules/webui/assets/js/settings/provider-selector.ts`, import the helper next to the existing imports:

```ts
import { setCompactLabel } from "./selector-line.js";
```

Replace lines 22-28:

```ts
  const label = t("web.selectors.provider");
  setCompactLabel(btn, label, value, providerIcon(active?.type, value));
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test tests/webui-compact-line.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/modules/webui/assets/js/icons.ts src/modules/webui/assets/js/settings/selectors-write.ts src/modules/webui/assets/js/settings/provider-selector.ts tests/webui-compact-line.test.ts
git commit -m "feat(webui): render compact composer selectors with semantic icons"
```

> **Deviation note (Task 2):** `provider-selector.ts` and `provider-icons.ts` were absent from this `dev`-based branch; they were restored from `88ee8b1b1` because the approved design requires the real llama.cpp brand mark. The three brand-icon CSS rules were restored too. A later merge with `feat/provider-icons` must keep this branch's compact button version (built via `setCompactLabel`), not the upstream labelled one.

---

### Task 3: Markup, CSS and the hint toggle

**Files:**
- Modify: `src/modules/webui/assets/index.html:93-114,129`
- Modify: `src/modules/webui/assets/styles.css:668,751-762,831,2770-2788`
- Create: `src/modules/webui/assets/js/session/hint-toggle.ts`
- Modify: `src/modules/webui/assets/app.ts:73,256`
- Test: `tests/webui-compact-line.test.ts`

- [ ] **Step 1: Add failing markup/CSS assertions to the existing test file**

Append to `tests/webui-compact-line.test.ts`:

```ts
const HTML = read("../src/modules/webui/assets/index.html");
const CSS = read("../src/modules/webui/assets/styles.css");

describe("compact composer markup", () => {
  it("separates selectors with `/` and keeps every menu", () => {
    expect(HTML).toContain('<span class="selector-sep" aria-hidden="true">/</span>');
    for (const name of ["provider", "model", "context", "reasoning"]) {
      expect(HTML).toContain(`data-sel="${name}"`);
    }
    for (const id of ["selProviderMenu", "selModelMenu", "selContextMenu", "selReasoningMenu"]) {
      expect(HTML).toContain(`id="${id}"`);
    }
  });

  it("drops chip surfaces and keeps the phone one-row rule", () => {
    expect(CSS).toMatch(/\.selectors\s*\{[^}]*flex-wrap:\s*nowrap/);
    expect(CSS).toMatch(/\.selectors > \.sel > button\s*\{[^}]*background:\s*none/);
    expect(CSS).toMatch(/\.sel\[data-sel="model"\]\s*\{\s*flex:\s*1 1 0/);
  });

  it("has a hint toggle for the compact hint row", () => {
    expect(HTML).toContain('id="hintMore"');
    expect(CSS).toMatch(/\.inp-meta\s+#hintShift\s*\{\s*display:\s*none/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/webui-compact-line.test.ts`
Expected: FAIL on `separates selectors with /` (markup not changed yet).

- [ ] **Step 3: Rewrite the selector row in `index.html`**

Replace the contents of `<div class="selectors">` (lines 93-114) with:

```html
<div class="selectors">
  <span class="composer-face" id="composerFace"></span>
  <div class="sel" data-sel="provider">
    <button id="selProviderBtn">— ▾</button>
    <div class="menu" id="selProviderMenu"></div>
  </div>
  <span class="selector-sep" aria-hidden="true">/</span>
  <div class="sel" data-sel="model">
    <button id="selModelBtn">— ▾</button>
    <div class="menu" id="selModelMenu"></div>
  </div>
  <span class="selector-sep" aria-hidden="true">/</span>
  <div class="sel" data-sel="context">
    <button id="selContextBtn">— ▾</button>
    <div class="menu" id="selContextMenu"></div>
  </div>
  <span class="selector-sep" aria-hidden="true">/</span>
  <div class="sel" data-sel="reasoning">
    <button id="selReasoningBtn">— ▾</button>
    <div class="menu" id="selReasoningMenu"></div>
  </div>
  <span class="caps-chip" id="capsChip" hidden></span>
  <span class="speed-chip" id="speedChip" hidden></span>
  <button class="tools-btn" id="toolsBtn" type="button" hidden aria-haspopup="dialog" title="Tools"></button>
</div>
```

Add the help button to `.inp-meta` (line 129), after `hintShort`:

```html
<button class="hint-more" id="hintMore" type="button" title="?" aria-label="?" aria-expanded="false">?</button>
```

- [ ] **Step 4: Add compact CSS**

Insert after the `.sel > button .provider-icon` rule (around line 761) in `styles.css`:

```css
/* Compact selector line (variant A): quiet text, `/` separators, no chip surface. */
.selectors { gap: 0; flex-wrap: nowrap; }
.selector-sep { color: var(--dim-b); margin: 0 6px; flex: none; user-select: none; }
.selector-sep[hidden] { display: none; }
.selectors > .sel { flex: 0 1 auto; }
.selectors > .sel[data-sel="model"] { flex: 1 1 auto; min-width: 0; }
.selectors > .sel > button { background: none; border: 0; padding: 2px 0; color: var(--muted); }
.selectors > .sel > button:hover { color: var(--fg); }
.selectors > .sel > button b { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.selectors > .sel > button > svg.svg-icon:last-child { color: var(--dim-b); opacity: 0; }
.selectors > .sel > button:hover > svg.svg-icon:last-child,
.selectors > .sel > button:focus-visible > svg.svg-icon:last-child { opacity: 1; }
```

Insert after `.inp-meta` (line 831):

```css
.inp-meta .hint-more {
  margin-left: auto; color: var(--dim-a); background: none; border: 0;
  padding: 0 2px; font: inherit; font-size: 11.5px; cursor: pointer;
}
.inp-meta .hint-more:hover { color: var(--fg); }
.inp-meta #hintShift { display: none; }
.inp-meta.expanded #hintShift { display: inline; }
```

In the existing `@media (pointer: coarse)` block (line 2786), add:

```css
  .inp-meta .hint-more { display: none; }
```

Do not change the phone `max-width: 640px` rules — `.sel[data-sel="model"] { flex: 1 1 0; }` must stay.

- [ ] **Step 5: Add the hint toggle module and wire it into boot**

Create `src/modules/webui/assets/js/session/hint-toggle.ts`:

```ts
/** `?` reveals the compressed keyboard hints on demand. */
export function initHintToggle(): void {
  const btn = document.getElementById("hintMore");
  const meta = document.querySelector<HTMLElement>(".inp-meta");
  if (!btn || !meta) return;
  btn.addEventListener("click", () => {
    const open = meta.classList.toggle("expanded");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  });
}
```

In `src/modules/webui/assets/app.ts`, add the import next to `initShortcuts` (line 73):

```ts
import { initHintToggle } from "./js/session/hint-toggle.js";
```

and call it after `initShortcuts();` (line 256):

```ts
    initHintToggle();
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test tests/webui-compact-line.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add src/modules/webui/assets/index.html src/modules/webui/assets/styles.css src/modules/webui/assets/js/session/hint-toggle.ts src/modules/webui/assets/app.ts tests/webui-compact-line.test.ts
git commit -m "feat(webui): compact composer markup, CSS and hint toggle"
```

---

### Task 4: Align the style guide

**Files:**
- Modify: `docs/design/ui/STYLE.md:99-127`

- [ ] **Step 1: Append the web-composer exception after the message-patterns block**

```md
### Web composer exception

Chat status lines keep the dim `·` separator. The compact web composer selector
row is the deliberate exception: it uses `/` because it is shorter and does not
collide with Windows paths (`\`) in the footer row. Icon roles stay unchanged —
Lucide marks are chrome only (brand provider mark, `ruler` context, `brain`
reasoning, `eye`/`wrench` capabilities); `◇`, `✦` and `·` remain textual.
```

- [ ] **Step 2: Verify docs links and commit**

Run: `bun test tests/docs-link-check.test.ts`
Expected: PASS.

```bash
git add docs/design/ui/STYLE.md
git commit -m "docs: record / separator exception for compact web composer"
```

---

### Task 5: Full verification

- [ ] **Step 1: Run the whole suite**

Run: `bun test`
Expected: all tests PASS, including `tests/webui-composer-chips.test.ts`, `tests/webui-shortcuts.test.ts`, `tests/webui-compact-selector-line.test.ts`, `tests/webui-compact-line.test.ts`.

- [ ] **Step 2: Run quality gates**

Run: `bun run quality`
Expected: typecheck + frontend build + arch gates + Biome + fallow PASS; no file exceeds 300 lines (new `selector-line.ts` and `hint-toggle.ts` are well below).

- [ ] **Step 3: Live check with an isolated config dir**

Run (background, log to file, stop by PID after the check):

```bash
MMA_CONFIG_DIR=<temp-dir> bun run web:dev -- --port 5199 --host 127.0.0.1 --no-open
```

Then in the browser: confirm one compact row with `/` separators, the full long model name at wide width, left-ellipsis tail at narrow width, all four dropdowns opening, pending spinner still visible while switching, `?` revealing Shift+Enter. Stop the process by its PID.

- [ ] **Step 4: Confirm no changelog change**

`CHANGELOG.md` must remain untouched — it is edited only on explicit user request. Do not commit anything from this task unless a fix was needed; fixes are committed with an explanatory message.

---

## Self-review notes

- Spec coverage: one quiet row (Tasks 2-3), `/` separator (Task 3 + Task 4), semantic icons including `ruler` (Tasks 2), long-name tail preservation (Task 1 + Task 2), compressed hints with `?` (Task 3), unchanged menus/pending/footer (static tests + live check), accessibility (Task 1), i18n parity (no new keys; Task 5 suite), no public contract change (no architecture spec).
- No placeholders: every code step contains full source; every test step has exact commands and expected outcomes.
- Type consistency: `setCompactLabel(btn, label, value, leading?)`, `leadingIcon(name)`, `syncSelectorSeparators(root?)`, `fitModelLabel(btn)`, `installModelFit(root?)`, `tailLabel(value, maxChars)` — used identically in all tasks.
