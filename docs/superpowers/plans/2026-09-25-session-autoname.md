# Session Auto-Naming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically give every session a meaningful name (deterministic first, LLM-refined background), while never overwriting a manual rename.

**Architecture:** Pure functions in `src/modules/session/auto-name.ts`; `SessionMeta.nameSource` tracks provenance; the single cross-transport hook lives in `Agent.run()` right after the first user message. The LLM title call is fire-and-forget and fail-open.

**Tech Stack:** Bun + TypeScript, vitest (`bun test`), i18n (`t()`), `LLMProvider.chat` streaming.

**Spec:** `docs/specs/2026-09-25-session-autoname-and-critic-design.md` §3.

---

## File Structure

- Create: `src/modules/session/auto-name.ts` — `deriveSessionName`, `sanitizeTitle`, `generateSessionTitle`, `TitleChat`.
- Modify: `src/modules/session/types.ts` — add `nameSource`.
- Modify: `src/modules/session/manager.ts` — `create`/`rename` set `nameSource`.
- Modify: `src/config/types.ts`, `src/config/defaults.ts` — `session.autoName`.
- Modify: `src/core/agent.ts` — first-message hook + `AgentDeps.getProviderName` reuse.
- Modify: `src/i18n/en.json`, `src/i18n/ru.json` — `session.auto_named`.
- Test: `tests/session-auto-name.test.ts` (new), `tests/session-manager.test.ts` (extend), `tests/core/agent-autoname.test.ts` (new).
- Modify: `docs/agents/architecture.md`, `AGENTS.md`, `CHANGELOG.md`.

---

### Task 1: `nameSource` on SessionMeta

**Files:**
- Modify: `src/modules/session/types.ts:3-26`
- Test: `tests/session-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/session-manager.test.ts`:

```ts
it("marks explicit create(name) as manual and default create() as default", () => {
  const store = new SessionStore(tmpDir);
  const mgr = new SessionManager(store, { model: "m", contextWindow: 1000, projectDir: tmpDir });
  const auto = mgr.create();
  expect(auto.nameSource).toBe("default");
  const named = mgr.create("My name");
  expect(named.nameSource).toBe("manual");
});

it("rename records the requested source (default manual)", () => {
  const store = new SessionStore(tmpDir);
  const mgr = new SessionManager(store, { model: "m", contextWindow: 1000, projectDir: tmpDir });
  const s = mgr.create();
  mgr.rename(s.id, "auto title", "auto");
  expect(mgr.get(s.id)!.nameSource).toBe("auto");
  mgr.rename(s.id, "user title");
  expect(mgr.get(s.id)!.nameSource).toBe("manual");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/session-manager.test.ts`
Expected: FAIL — property `nameSource` does not exist / `rename` takes 2 args.

- [ ] **Step 3: Implement**

In `src/modules/session/types.ts` add to `SessionMeta` after `name`:

```ts
  /** Provenance of `name`: default date name, auto-generated, or user-set. */
  nameSource?: "default" | "auto" | "manual";
```

In `src/modules/session/manager.ts`:

```ts
  create(name?: string, securityOverrides?: SessionMeta["securityOverrides"]): SessionMeta {
    const now = new Date().toISOString();
    const id = `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const sessionName = name || t("session.default_name", { date: now.slice(0, 10) });
    const meta: SessionMeta = {
      id,
      name: sessionName,
      nameSource: name ? "manual" : "default",
      // ...unchanged fields...
    };
```

Replace `rename`:

```ts
  rename(id: string, name: string, source: "auto" | "manual" = "manual"): void {
    const meta = this.store.loadMeta(id);
    if (!meta) throw new Error(t("session.not_found", { id }));
    meta.name = name;
    meta.nameSource = source;
    this.store.saveMeta(id, meta);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/session-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/session/types.ts src/modules/session/manager.ts tests/session-manager.test.ts
git commit -m "feat(session): track nameSource on session meta"
```

---

### Task 2: Pure `deriveSessionName` / `sanitizeTitle`

**Files:**
- Create: `src/modules/session/auto-name.ts`
- Test: `tests/session-auto-name.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/session-auto-name.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveSessionName, sanitizeTitle } from "../src/modules/session/auto-name";

describe("deriveSessionName", () => {
  it("uses the first non-empty line", () => {
    expect(deriveSessionName("\n\n  Fix the login bug \n more")).toBe("Fix the login bug");
  });
  it("strips markdown, inline code and urls", () => {
    expect(deriveSessionName("## Add `grep` tool to https://x.io/doc")).toBe("Add tool to");
  });
  it("strips trailing punctuation", () => {
    expect(deriveSessionName("Weather in Paris?")).toBe("Weather in Paris");
  });
  it("caps at word boundary with ellipsis", () => {
    const out = deriveSessionName("a".repeat(10) + " " + "b".repeat(80));
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out.endsWith("…")).toBe(true);
  });
  it("falls back to the date default when nothing remains", () => {
    expect(deriveSessionName("https://only-a-url.example", "2026-09-25")).toBe(
      "Session 2026-09-25",
    );
  });
});

describe("sanitizeTitle", () => {
  it("takes the first line and strips wraps/punctuation", () => {
    expect(sanitizeTitle('"Fix Login Bug."\nextra')).toBe("Fix Login Bug");
  });
  it("returns null for empty output", () => {
    expect(sanitizeTitle("  \n ")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/session-auto-name.test.ts`
Expected: FAIL — cannot resolve `../src/modules/session/auto-name`.

- [ ] **Step 3: Implement**

Create `src/modules/session/auto-name.ts`:

```ts
import { t } from "../../i18n/index";

const MAX_NAME_LEN = 60;
const MIN_CUT = 20;

/** Deterministic, instant session name from the first user message. */
export function deriveSessionName(input: string, date?: string): string {
  const firstLine = input.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  let s = firstLine
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/^[#>\-*+\s]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?…]+$/u, "")
    .trim();
  if (!s) {
    return t("session.default_name", { date: date ?? new Date().toISOString().slice(0, 10) });
  }
  if (s.length > MAX_NAME_LEN) {
    const cut = s.slice(0, MAX_NAME_LEN);
    const lastSpace = cut.lastIndexOf(" ");
    s = `${(lastSpace > MIN_CUT ? cut.slice(0, lastSpace) : cut).trim()}…`;
  }
  return s;
}

/** Normalize a model-produced title; returns null when unusable. */
export function sanitizeTitle(raw: string): string | null {
  const first =
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const cleaned = first.replace(/^["'«»`]+|["'«»`.!,;:]+$/gu, "").trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_NAME_LEN ? `${cleaned.slice(0, MAX_NAME_LEN).trim()}…` : cleaned;
}

export type TitleChat = (prompt: string, signal?: AbortSignal) => Promise<string>;

export function buildTitlePrompt(input: string): string {
  const excerpt = input.slice(0, 1000);
  return [
    "Give a short session title for the message below.",
    "Rules: 3-6 words, same language as the message, no quotes, no emoji, no trailing punctuation.",
    "Reply with the title only.",
    "",
    excerpt,
  ].join("\n");
}

/** One-shot LLM title with timeout. Fail-open — returns null on any error. */
export async function generateSessionTitle(
  input: string,
  chat: TitleChat,
  timeoutMs = 8000,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const raw = await chat(buildTitlePrompt(input), controller.signal);
    return sanitizeTitle(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/session-auto-name.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/session/auto-name.ts tests/session-auto-name.test.ts
git commit -m "feat(session): deterministic name + title sanitizer"
```

---

### Task 3: Config `session.autoName`

**Files:**
- Modify: `src/config/types.ts:143-147`
- Modify: `src/config/defaults.ts:92-96`
- Test: `tests/config-defaults.test.ts` (or nearest config test)

- [ ] **Step 1: Write the failing test**

```ts
it("defaults session.autoName to true", () => {
  expect(DEFAULTS.session.autoName).toBe(true);
});
```

- [ ] **Step 2: Run test** — `bun test tests/config-defaults.test.ts` → FAIL (`undefined`).

- [ ] **Step 3: Implement**

```ts
export interface SessionConfig {
  autoSave: boolean;
  maxSessions: number;
  isolateMemory: boolean;
  /** LLM-refine the session name after the first message (deterministic name always applies). */
  autoName: boolean;
}
```

```ts
  session: {
    autoSave: true,
    maxSessions: 50,
    isolateMemory: false,
    autoName: true,
  },
```

- [ ] **Step 4: Run test** → PASS.
- [ ] **Step 5: Commit** — `feat(config): add session.autoName`.

---

### Task 4: Agent first-message hook

**Files:**
- Modify: `src/core/agent.ts:82-149` (AgentDeps), `501-590` (run)
- Test: `tests/core/agent-autoname.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/core/agent-autoname.test.ts` following the existing Agent test harness (see `tests/core/agent-turn-end.test.ts` for a full mock `AgentDeps`). Core assertions:

```ts
it("sets a deterministic name on the first message", async () => {
  const { agent, sessionManager } = makeAgent();
  await agent.run("Fix the login bug");
  expect(sessionManager.getActiveMeta()!.name).toBe("Fix the login bug");
  expect(sessionManager.getActiveMeta()!.nameSource).toBe("auto");
});

it("does not overwrite a manual name", async () => {
  const { agent, sessionManager } = makeAgent();
  sessionManager.rename(sessionManager.create("Manual").id, "Manual");
  await agent.run("Something else");
  expect(sessionManager.getActiveMeta()!.name).toBe("Manual");
});
```

Provide a `makeAgent()` in the test file that builds a `SessionManager` over a temp dir and a minimal `AgentDeps` with a stub `LLMProvider` whose `chat` yields one `{type:"text"}` chunk (`"Stub Title"`) then `{type:"done"}`.

- [ ] **Step 2: Run** — `bun test tests/core/agent-autoname.test.ts` → FAIL.

- [ ] **Step 3: Implement in `Agent.run`**

Right after the `if (sessionManager && !sessionManager.getActive())` block (line ~530) add:

```ts
    const activeMeta = sessionManager?.getActiveMeta();
    const isFirstMessage = !!activeMeta && activeMeta.messageCount === 0;
```

After `slog.logUser(input);` (line 590) add:

```ts
    if (isFirstMessage && activeMeta && sessionManager) {
      const meta = sessionManager.getActiveMeta();
      if (meta && (meta.nameSource ?? "default") !== "manual") {
        sessionManager.rename(meta.id, deriveSessionName(input), "auto");
        if (config.session.autoName !== false) {
          const chat: TitleChat = async (prompt, signal) => {
            let text = "";
            for await (const chunk of llmProvider.chat(
              [{ role: "user", content: prompt }],
              undefined,
              signal,
              { maxTokens: 48, reasoningEffort: "none" },
            )) {
              if (chunk.type === "text" && chunk.content) text += chunk.content;
            }
            return text;
          };
          void generateSessionTitle(input, chat)
            .then((title) => {
              if (!title) return;
              const cur = sessionManager.getActiveMeta();
              if (cur && cur.id === meta.id && (cur.nameSource ?? "default") === "auto") {
                sessionManager.rename(meta.id, title, "auto");
              }
            })
            .catch(() => {});
        }
      }
    }
```

Add imports at the top of `src/core/agent.ts`:

```ts
import { deriveSessionName, generateSessionTitle, type TitleChat } from "../modules/session/auto-name";
```

- [ ] **Step 4: Run** — `bun test tests/core/agent-autoname.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(agent): auto-name session on first message`.

---

### Task 5: i18n + docs + web refresh

**Files:**
- Modify: `src/i18n/en.json:90`, `src/i18n/ru.json` (mirror), `src/modules/webui/assets/app.js:1766` area, `CHANGELOG.md`, `AGENTS.md`, `docs/agents/architecture.md`

- [ ] **Step 1:** Add `"session.auto_named": "Session auto-named: {name}"` (en) and `"Сессия названа: {name}"` (ru). Optionally emit in verbose only — do not print by default (STYLE.md quiet).
- [ ] **Step 2:** Web: in `src/modules/webui/assets/app.js`, refresh the active tab label from `state.host.sessionName` on each `state` event; the existing `openTab` path at line 1766 already reads it. Add a small `updateTabName(sessionId, name)` and call it when the SSE `state` payload's `sessionName` changes.
- [ ] **Step 3:** Verify web asset test still passes: `bun test tests/webui-server.test.ts`.
- [ ] **Step 4:** CHANGELOG entry (`### Added`): session auto-naming; AGENTS.md short bullet; architecture.md session section.
- [ ] **Step 5: Quality gate**

Run: `bun test && tsc --noEmit && bun run lint`
Expected: green.

- [ ] **Step 6: Commit** — `docs(session): auto-naming i18n, web refresh, changelog`.

---

## Self-Review Checklist

- [ ] `nameSource` written in `create` and `rename`; manual never overwritten (Task 1, 4).
- [ ] Deterministic name is instant and non-blocking (Task 2, 4).
- [ ] LLM title fail-open + timeout + stale-session guard (Task 2, 4).
- [ ] `session.autoName=false` keeps deterministic name only (Task 3, 4).
- [ ] No stdout/`--json` pollution; name lives in session meta.
