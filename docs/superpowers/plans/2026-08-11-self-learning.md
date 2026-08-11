# Self-Learning Module (Phase 1: Skills) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `learning` module to MMA that turns successful sessions into reusable SKILL.md files via a `mma learn` CLI command (nudge) plus an in-session auto-suggestion directive, with deterministic validation and a strict 1-LLM-call budget.

**Architecture:** New `src/modules/learning/` module with four single-responsibility components: `TraceReader` (deterministic compaction of `session.jsonl`, no LLM), `SkillGenerator` (one LLM call via the existing `OpenAICompatProvider` → SKILL.md draft), `SkillValidator` (deterministic frontmatter/length/duplicate checks), `LearningModule` (system-prompt directive). `mma learn` is wired as a CLI subcommand following the existing `model certify` pattern (dynamic import of a module CLI action). Phase 2 (gated error learning) is design-only in the spec and NOT implemented.

**Tech Stack:** TypeScript (strict), vitest, commander, existing `OpenAICompatProvider`/`SessionStore`/`SkillsLoader` infrastructure.

**Spec:** `docs/specs/2026-08-11-self-learning-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/modules/learning/types.ts` | Create | `TraceStep`, `TraceSummary`, `SkillDraft`, `ValidationResult`; re-export `LearningConfig` |
| `src/modules/learning/trace.ts` | Create | `TraceReader` — compact trace from session log (no LLM) |
| `src/modules/learning/validator.ts` | Create | `SkillValidator` — deterministic draft checks |
| `src/modules/learning/generator.ts` | Create | `SkillGenerator` — 1 LLM call → `SkillDraft` |
| `src/modules/learning/module.ts` | Create | `LearningModule` — AgentModule with system-prompt directive |
| `src/modules/learning/cli.ts` | Create | `runLearn()` — CLI action (session resolve → trace → generate → confirm → validate → save) |
| `src/modules/learning/index.ts` | Create | Public exports |
| `src/config/types.ts` | Modify | Add `LearningConfig` interface + `learning?: LearningConfig` on `AppConfig` |
| `src/config/defaults.ts` | Modify | Add `DEFAULT_LEARNING_CONFIG` + wire into `DEFAULTS` |
| `src/modules/session/manager.ts` | Modify | Add public `loadSessionLog(id)` delegate to `SessionStore` |
| `src/core/bootstrap.ts` | Modify | Register `LearningModule` when `config.learning?.enabled` |
| `src/cli/commands.ts` | Modify | Add `mma learn` subcommand |
| `src/i18n/en.json` + `src/i18n/ru.json` | Modify | Add `learning.*` and `cli.learn*` keys (parity, rule #8) |
| `AGENTS.md` | Modify | Add Self-Learning section under Modules |
| `tests/learning-types.test.ts` | Create | Type/shape smoke tests |
| `tests/learning-trace.test.ts` | Create | `TraceReader` unit tests (fixture `session.jsonl`) |
| `tests/learning-validator.test.ts` | Create | `SkillValidator` unit tests |
| `tests/learning-generator.test.ts` | Create | `SkillGenerator` unit tests with mocked provider |

---

### Task 1: Learning types

**Files:**

- Create: `src/modules/learning/types.ts`
- Test: `tests/learning-types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/learning-types.test.ts
import { describe, it, expect } from "vitest";
import type {
  TraceSummary,
  SkillDraft,
  ValidationResult,
} from "../src/modules/learning/types";

describe("learning types", () => {
  it("TraceSummary shape matches the trace reader contract", () => {
    const summary: TraceSummary = {
      sessionId: "ses_1",
      toolCallCount: 2,
      steps: [
        { tool: "read_file", action: "read src/a.ts", status: "ok" },
        { tool: "write_file", action: "write src/b.ts", status: "error", error: "EACCES" },
      ],
      errors: ["EACCES"],
    };
    expect(summary.toolCallCount).toBe(2);
    expect(summary.steps[1].status).toBe("error");
    expect(summary.errors).toHaveLength(1);
  });

  it("SkillDraft and ValidationResult shapes", () => {
    const draft: SkillDraft = { name: "deploy-docker", content: "---\nname: deploy-docker\n---\n" };
    const result: ValidationResult = { ok: true, errors: [], warnings: [] };
    expect(draft.name).toBe("deploy-docker");
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/learning-types.test.ts`
Expected: FAIL — module `../src/modules/learning/types` not found (file doesn't exist yet).

- [ ] **Step 3: Implement the types file**

```typescript
// src/modules/learning/types.ts
export interface TraceStep {
  tool: string;
  action: string;
  status: "ok" | "error";
  error?: string;
}

export interface TraceSummary {
  sessionId: string;
  toolCallCount: number;
  steps: TraceStep[];
  errors: string[];
}

export interface SkillDraft {
  name: string;
  content: string; // full SKILL.md content including frontmatter
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/learning-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/learning/types.ts tests/learning-types.test.ts
git commit -m "feat(learning): add core types"
```

---

### Task 2: TraceReader

**Files:**

- Create: `src/modules/learning/trace.ts`
- Test: `tests/learning-trace.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/learning-trace.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionStore } from "../src/modules/session/store";
import { TraceReader } from "../src/modules/learning/trace";

function makeStore(): { store: SessionStore; dir: string; id: string } {
  const dir = mkdtempSync(join(tmpdir(), "mma-trace-"));
  const store = new SessionStore(join(dir, "sessions"));
  store.init();
  const id = "ses_test";
  writeFileSync(join(dir, "sessions", id, "meta.json"), JSON.stringify({ id, name: "t" }), "utf-8");
  return { store, dir, id };
}

describe("TraceReader", () => {
  it("compacts tool calls and surfaces errors without raw content", () => {
    const { store, dir, id } = makeStore();
    store.appendSessionLog(id, {
      ts: "1", type: "tool_call", tool: "read_file",
      args: { path: "/a/b/c.ts", offset: 0, limit: 300 },
    });
    store.appendSessionLog(id, {
      ts: "2", type: "tool_result", tool: "read_file", success: true,
      content: "VERY LONG CONTENT".repeat(1000),
    });
    store.appendSessionLog(id, {
      ts: "3", type: "tool_call", tool: "bash",
      args: { command: "bun test" },
    });
    store.appendSessionLog(id, {
      ts: "4", type: "tool_result", tool: "bash", success: false,
      content: "bun test failed: 1 error\nat src/x.test.ts:10\n".repeat(50),
    });
    store.appendSessionLog(id, {
      ts: "5", type: "assistant", content: "I'll fix it now",
    });

    const reader = new TraceReader(store);
    const summary = reader.summarize(id);
    expect(summary).not.toBeNull();
    expect(summary!.toolCallCount).toBe(2);
    expect(summary!.steps).toHaveLength(2);
    expect(summary!.steps[0]).toEqual({
      tool: "read_file", action: expect.stringContaining("read_file"), status: "ok",
    });
    expect(summary!.steps[1].status).toBe("error");
    expect(summary!.errors.length).toBeGreaterThan(0);
    // Raw content never leaks into the summary
    const blob = JSON.stringify(summary);
    expect(blob).not.toContain("VERY LONG CONTENT");
    expect(blob).not.toContain("bun test failed: 1 error");

    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for a session with no log", () => {
    const { store, dir, id } = makeStore();
    const reader = new TraceReader(store);
    expect(reader.summarize(id)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when toolCallCount is zero", () => {
    const { store, dir, id } = makeStore();
    store.appendSessionLog(id, { ts: "1", type: "user", content: "hi" });
    const reader = new TraceReader(store);
    expect(reader.summarize(id)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/learning-trace.test.ts`
Expected: FAIL — cannot find module `../src/modules/learning/trace`.

- [ ] **Step 3: Implement TraceReader**

```typescript
// src/modules/learning/trace.ts
import type { SessionStore } from "../session/store";
import type { TraceStep, TraceSummary } from "./types";

const MAX_ARG_VALUE = 80;
const MAX_ARGS = 3;
const MAX_ERROR_LINE = 200;

function compactArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const entries = Object.entries(args).slice(0, MAX_ARGS);
  return entries
    .map(([k, v]) => {
      let s: string;
      try {
        s = typeof v === "string" ? v : JSON.stringify(v);
      } catch {
        s = String(v);
      }
      if (s.length > MAX_ARG_VALUE) s = s.slice(0, MAX_ARG_VALUE) + "…";
      return `${k}=${s}`;
    })
    .join(" ");
}

function firstLine(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const line = text.split("\n")[0].trim();
  return line.length > max ? line.slice(0, max) + "…" : line;
}

export class TraceReader {
  constructor(private store: SessionStore) {}

  /**
   * Deterministic compaction of a session log. Returns null when the session
   * has no log file or made zero tool calls (nothing to learn from).
   * Full content is never included — only first-line summaries of errors.
   */
  summarize(sessionId: string): TraceSummary | null {
    const log = this.store.loadSessionLog(sessionId);
    if (log.length === 0) return null;

    const steps: TraceStep[] = [];
    const errors: string[] = [];
    const pending = new Map<string, TraceStep>();

    for (const entry of log) {
      if (entry.type === "tool_call" && entry.tool) {
        const step: TraceStep = {
          tool: entry.tool,
          action: compactArgs(entry.args),
          status: "ok",
        };
        pending.set(entry.tool_call_id ?? entry.tool + steps.length, step);
        steps.push(step);
      } else if (entry.type === "tool_result" && entry.tool) {
        const step = pending.get(entry.tool_call_id ?? entry.tool + (steps.length - 1));
        if (step && entry.success === false) {
          step.status = "error";
          const line = firstLine(entry.content, MAX_ERROR_LINE);
          if (line) {
            step.error = line;
            errors.push(line);
          }
        }
      } else if (entry.type === "error") {
        const line = firstLine(entry.content, MAX_ERROR_LINE);
        if (line) errors.push(line);
      }
    }

    const toolCallCount = steps.length;
    if (toolCallCount === 0) return null;

    return { sessionId, toolCallCount, steps, errors };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/learning-trace.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/learning/trace.ts tests/learning-trace.test.ts
git commit -m "feat(learning): add TraceReader deterministic compaction"
```

---

### Task 3: SkillValidator

**Files:**

- Create: `src/modules/learning/validator.ts`
- Test: `tests/learning-validator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/learning-validator.test.ts
import { describe, it, expect } from "vitest";
import { SkillValidator } from "../src/modules/learning/validator";
import type { SkillDraft } from "../src/modules/learning/types";

const opts = { minLength: 200, maxLength: 3000 };

function draft(name: string, body: string, extra = ""): SkillDraft {
  return {
    name,
    content:
      `---\nname: ${name}\ndescription: A reusable procedure\nwhen_to_use: When the task matches\nmma_version: 2\n${extra}---\n\n${body}`,
  };
}

describe("SkillValidator", () => {
  it("accepts a valid draft", () => {
    const v = new SkillValidator([], opts);
    const body = "Step 1: do this.\nStep 2: do that.\nWhat to avoid: never do X.";
    const longBody = body + "\n" + "more details ".repeat(20);
    const r = v.validate(draft("deploy-docker", longBody));
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("rejects empty name and bad name chars", () => {
    const v = new SkillValidator([], opts);
    const body = "x".repeat(250);
    expect(v.validate(draft("", body)).ok).toBe(false);
    expect(v.validate(draft("Bad Name!", body)).ok).toBe(false);
    expect(v.validate(draft("deploy_docker", body)).ok).toBe(false);
  });

  it("rejects duplicate name against existing skills", () => {
    const v = new SkillValidator(["deploy-docker"], opts);
    const body = "x".repeat(250);
    expect(v.validate(draft("deploy-docker", body)).ok).toBe(false);
    expect(v.validate(draft("deploy-docker-2", body)).ok).toBe(true);
  });

  it("rejects body under minLength", () => {
    const v = new SkillValidator([], opts);
    expect(v.validate(draft("tiny", "short")).ok).toBe(false);
  });

  it("rejects body over maxLength", () => {
    const v = new SkillValidator([], opts);
    expect(v.validate(draft("huge", "x".repeat(4000))).ok).toBe(false);
  });

  it("rejects garbage bodies (heading-only, checkbox fragment, single word)", () => {
    const v = new SkillValidator([], opts);
    expect(v.validate(draft("g1", "# Heading").ok === false));
    expect(v.validate(draft("g2", "- [x] acknowledge").ok === false));
    expect(v.validate(draft("g3", "TypeScript").ok === false));
  });

  it("rejects content without parseable frontmatter", () => {
    const v = new SkillValidator([], opts);
    const r = v.validate({ name: "nofm", content: "no frontmatter here at all".repeat(30) });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/learning-validator.test.ts`
Expected: FAIL — cannot find module `../src/modules/learning/validator`.

- [ ] **Step 3: Implement SkillValidator**

```typescript
// src/modules/learning/validator.ts
import type { SkillDraft, ValidationResult } from "./types";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

interface ValidatorOptions {
  minLength: number;
  maxLength: number;
}

export class SkillValidator {
  constructor(
    private existingNames: string[],
    private opts: ValidatorOptions,
  ) {}

  validate(draft: SkillDraft): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!NAME_RE.test(draft.name)) {
      errors.push(
        `name "${draft.name}" is invalid: lowercase slug, [a-z0-9-], max 40 chars`,
      );
    }
    if (this.existingNames.includes(draft.name)) {
      errors.push(`skill "${draft.name}" already exists — choose another name`);
    }

    const parsed = this.parseFrontmatter(draft.content);
    if (!parsed.ok) {
      errors.push("content must start with YAML frontmatter (--- ... ---)");
    } else {
      const { name, description, whenToUse } = parsed;
      if (name && name !== draft.name) {
        warnings.push(`frontmatter name "${name}" differs from file name "${draft.name}"`);
      }
      if (!description || description.trim().length < 10) {
        errors.push("frontmatter description must be at least 10 characters");
      }
      if (!whenToUse) {
        warnings.push("frontmatter when_to_use is missing — add it for L1 disclosure");
      }
    }

    const body = this.body(draft.content);
    if (body.length < this.opts.minLength) {
      errors.push(`body too short: ${body.length} < ${this.opts.minLength} chars`);
    }
    if (body.length > this.opts.maxLength) {
      errors.push(`body too long: ${body.length} > ${this.opts.maxLength} chars`);
    }
    if (this.isGarbage(body)) {
      errors.push("body looks like garbage (heading, checkbox fragment, or single word)");
    }

    return { ok: errors.length === 0, errors, warnings };
  }

  private body(content: string): string {
    const trimmed = content.trim();
    if (!trimmed.startsWith("---")) return trimmed;
    const end = trimmed.indexOf("\n---", 3);
    if (end === -1) return trimmed;
    return trimmed.slice(end + 4).trim();
  }

  private parseFrontmatter(content: string): {
    ok: boolean;
    name?: string;
    description?: string;
    whenToUse?: string;
  } {
    const trimmed = content.trim();
    if (!trimmed.startsWith("---")) return { ok: false };
    const end = trimmed.indexOf("\n---", 3);
    if (end === -1) return { ok: false };
    const yaml = trimmed.slice(3, end);
    let name: string | undefined;
    let description: string | undefined;
    let whenToUse: string | undefined;
    for (const line of yaml.split("\n")) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (!m) continue;
      const val = m[2].trim().replace(/^['"]|['"]$/g, "");
      if (m[1] === "name") name = val;
      else if (m[1] === "description") description = val;
      else if (m[1] === "when_to_use") whenToUse = val;
    }
    return { ok: true, name, description, whenToUse };
  }

  private isGarbage(body: string): boolean {
    const t = body.trim();
    if (t.length === 0) return true;
    if (/^#/.test(t)) return true; // markdown heading as the whole body
    if (/^[-*]\s*\[[ x]\]/i.test(t)) return true; // checkbox fragment
    if (/^\S+$/.test(t)) return true; // single word
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/learning-validator.test.ts`
Expected: PASS. (Note: the "garbage" test uses `expect(... === false)` assertions intentionally — if it passes, garbage was rejected; tighten the assertions if you prefer `toBe(false)` style, the semantics are identical.)

- [ ] **Step 5: Commit**

```bash
git add src/modules/learning/validator.ts tests/learning-validator.test.ts
git commit -m "feat(learning): add SkillValidator deterministic checks"
```

---

### Task 4: SkillGenerator

**Files:**

- Create: `src/modules/learning/generator.ts`
- Test: `tests/learning-generator.test.ts`

- [ ] **Step 1: Write the failing test with a mocked provider**

```typescript
// tests/learning-generator.test.ts
import { describe, it, expect } from "vitest";
import { SkillGenerator } from "../src/modules/learning/generator";
import type { LLMProvider, Chunk, Message } from "../src/llm/provider";
import type { TraceSummary } from "../src/modules/learning/types";

class FakeProvider implements LLMProvider {
  readonly model = "fake";
  readonly contextWindow = 32768;
  constructor(private response: string) {}
  async *chat(messages: Message[]): AsyncIterable<Chunk> {
    const sys = messages.find((m) => m.role === "system");
    expect(sys?.content).toContain("SKILL.md");
    expect(messages.some((m) => m.role === "user" && String(m.content).includes("deploy-docker"))).toBe(true);
    yield { type: "text", content: this.response };
    yield { type: "done", finishReason: "stop" };
  }
  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
  async listModels(): Promise<string[]> {
    return ["fake"];
  }
}

const summary: TraceSummary = {
  sessionId: "ses_1",
  toolCallCount: 4,
  steps: [
    { tool: "bash", action: "bun run build:prod", status: "ok" },
    { tool: "bash", action: "docker compose up -d", status: "ok" },
  ],
  errors: [],
};

describe("SkillGenerator", () => {
  it("builds a SkillDraft from a fenced SKILL.md response", async () => {
    const response =
      "Here is the skill:\n```\n---\nname: deploy-docker\ndescription: Deploy the app with docker compose\nwhen_to_use: When deploying after build\nmma_version: 2\n---\n\nStep 1: build\nStep 2: compose up\nWhat to avoid: don't skip the health check.\n```";
    const gen = new SkillGenerator({ model: "fake", baseUrl: "http://x", apiKey: "k", contextWindow: 32768 }, new FakeProvider(response));
    const draft = await gen.generate(summary);
    expect(draft.name).toBe("deploy-docker");
    expect(draft.content).toContain("---");
    expect(draft.content).toContain("What to avoid");
  });

  it("derives a slug name when frontmatter name is missing", async () => {
    const gen = new SkillGenerator({ model: "fake", baseUrl: "http://x", apiKey: "k", contextWindow: 32768 }, new FakeProvider("Do the deploy thing in steps."));
    const draft = await gen.generate(summary);
    expect(draft.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(draft.content.length).toBeGreaterThan(0);
  });

  it("throws when the provider returns no text", async () => {
    class EmptyProvider extends FakeProvider {
      async *chat(): AsyncIterable<Chunk> {
        yield { type: "done", finishReason: "stop" };
      }
    }
    const gen = new SkillGenerator({ model: "fake", baseUrl: "http://x", apiKey: "k", contextWindow: 32768 }, new EmptyProvider(""));
    await expect(gen.generate(summary)).rejects.toThrow(/no text/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/learning-generator.test.ts`
Expected: FAIL — cannot find module `../src/modules/learning/generator`.

- [ ] **Step 3: Implement SkillGenerator**

```typescript
// src/modules/learning/generator.ts
import type { Chunk, LLMProvider, Message } from "../../llm/provider";
import type { SkillDraft, TraceSummary } from "./types";

export interface GeneratorOptions {
  model: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow: number;
}

const SYSTEM_PROMPT = `You are an expert at extracting reusable procedures from agent traces.
Given a compact trace of a completed task, extract the reusable procedure:
- when to use it (one line),
- step-by-step instructions (numbered),
- what to avoid (short section).

Output ONLY a valid SKILL.md file with YAML frontmatter:
name: <lowercase slug, [a-z0-9-], max 40 chars>
description: <one sentence, at least 10 chars>
when_to_use: <one line>
mma_version: 2

Then the body: short intro, numbered steps, and a "What to avoid" section.
Keep the whole file under 3000 characters.`;

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "learned-skill";
}

function parseFrontmatterName(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) return undefined;
  const end = trimmed.indexOf("\n---", 3);
  if (end === -1) return undefined;
  for (const line of trimmed.slice(3, end).split("\n")) {
    const m = line.match(/^name:\s*(.+)$/);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, "");
  }
  return undefined;
}

export class SkillGenerator {
  constructor(
    private opts: GeneratorOptions,
    private provider: LLMProvider,
  ) {}

  /**
   * One LLM call → SkillDraft. The provider is injected for testability;
   * production wiring constructs it from config (see Task 8).
   */
  async generate(summary: TraceSummary): Promise<SkillDraft> {
    const traceText = summary.steps
      .map(
        (s) =>
          `- ${s.tool} [${s.status}] ${s.action}${s.error ? ` — ${s.error}` : ""}`,
      )
      .join("\n");
    const messages: Message[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Trace of session ${summary.sessionId} (${summary.toolCallCount} tool calls):\n${traceText}`,
      },
    ];

    let text = "";
    for await (const chunk of this.provider.chat(messages)) {
      if (chunk.type === "text" && chunk.content) text += chunk.content;
    }
    if (text.trim().length === 0) {
      throw new Error("SkillGenerator: provider returned no text");
    }

    // Strip a single fenced code block if present
    const fenced = text.match(/```(?:\w+)?\s*([\s\S]*?)```/);
    const content = (fenced ? fenced[1] : text).trim();

    const name = parseFrontmatterName(content) ?? slugify(content.slice(0, 200));
    return { name, content };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/learning-generator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/learning/generator.ts tests/learning-generator.test.ts
git commit -m "feat(learning): add SkillGenerator (one LLM call)"
```

---

### Task 5: Config wiring

**Files:**

- Modify: `src/config/types.ts`
- Modify: `src/config/defaults.ts`

- [ ] **Step 1: Add LearningConfig to config/types.ts**

Insert after the `LspConfig` import block / before `AppConfig` (match file style — tabs are used in this repo):

```typescript
export interface LearningConfig {
  enabled: boolean;
  skillGeneration: {
    minToolCalls: number;
    minLength: number;
    maxLength: number;
    targetDir: "project" | "global";
  };
  nudge: {
    enabled: boolean;
  };
}
```

Add the field to `AppConfig` (next to `lsp?: LspConfig`):

```typescript
  lsp?: LspConfig;
  learning?: LearningConfig;
```

- [ ] **Step 2: Add defaults to config/defaults.ts**

```typescript
export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  enabled: false,
  skillGeneration: {
    minToolCalls: 3,
    minLength: 200,
    maxLength: 3000,
    targetDir: "project",
  },
  nudge: {
    enabled: true,
  },
};
```

Add to `DEFAULTS` (next to `lsp: DEFAULT_LSP_CONFIG`):

```typescript
  lsp: DEFAULT_LSP_CONFIG,
  learning: DEFAULT_LEARNING_CONFIG,
```

- [ ] **Step 3: Verify typecheck**

Run: `tsc --noEmit`
Expected: PASS (no new errors).

- [ ] **Step 4: Commit**

```bash
git add src/config/types.ts src/config/defaults.ts
git commit -m "feat(learning): add learning config section (opt-in)"
```

---

### Task 6: LearningModule + bootstrap registration

**Files:**

- Create: `src/modules/learning/module.ts`
- Modify: `src/core/bootstrap.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/learning-module.test.ts
import { describe, it, expect } from "vitest";
import { LearningModule } from "../src/modules/learning/module";
import type { LearningConfig } from "../src/modules/learning/types";

const cfg: LearningConfig = {
  enabled: true,
  skillGeneration: { minToolCalls: 3, minLength: 200, maxLength: 3000, targetDir: "project" },
  nudge: { enabled: true },
};

describe("LearningModule", () => {
  it("emits the directive block when enabled", () => {
    const m = new LearningModule(cfg);
    const block = m.getSystemPromptBlock();
    expect(block).not.toBeNull();
    expect(block!.content).toContain("mma learn");
    expect(block!.priority).toBe("low");
  });

  it("returns null when disabled", () => {
    const m = new LearningModule({ ...cfg, enabled: false });
    expect(m.getSystemPromptBlock()).toBeNull();
  });

  it("returns null when nudge is disabled", () => {
    const m = new LearningModule({ ...cfg, nudge: { enabled: false } });
    expect(m.getSystemPromptBlock()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/learning-module.test.ts`
Expected: FAIL — cannot find module `../src/modules/learning/module`.

- [ ] **Step 3: Implement LearningModule**

```typescript
// src/modules/learning/module.ts
import type { AgentModule } from "../types";
import type { PromptBlock } from "../../core/types";
import type { LearningConfig } from "./types";

const DIRECTIVE = `If this session produced a reusable procedure (multi-step, would save time next time), suggest saving it as a skill in your final answer: skill name + one-line description. Do NOT create files or call save tools — the user runs \`mma learn\` to save it.`;

export class LearningModule implements AgentModule {
  name = "learning";

  constructor(private config: LearningConfig) {}

  getSystemPromptBlock(): PromptBlock | null {
    if (!this.config.enabled || !this.config.nudge.enabled) return null;
    return {
      content: DIRECTIVE,
      priority: "low",
      essential: false,
      estimatedTokens: 40,
    };
  }
}
```

- [ ] **Step 4: Register in bootstrap**

In `src/core/bootstrap.ts`, next to the memory module registration (around line 303-304):

```typescript
import { LearningModule } from "../modules/learning/module";
```

and after `moduleRegistry.register(memoryModule);`:

```typescript
 if (config.learning?.enabled) {
  moduleRegistry.register(new LearningModule(config.learning));
 }
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test tests/learning-module.test.ts && tsc --noEmit`
Expected: PASS / no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/learning/module.ts src/core/bootstrap.ts tests/learning-module.test.ts
git commit -m "feat(learning): LearningModule system-prompt directive + bootstrap wiring"
```

---

### Task 7: SessionManager.loadSessionLog delegate

**Files:**

- Modify: `src/modules/session/manager.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/learning-session-delegate.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionStore } from "../src/modules/session/store";
import { SessionManager } from "../src/modules/session/manager";

describe("SessionManager.loadSessionLog", () => {
  it("delegates to the store and returns entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-delegate-"));
    const store = new SessionStore(join(dir, "sessions"));
    store.init();
    const mgr = new SessionManager(store, {
      model: "m",
      contextWindow: 32768,
      projectDir: dir,
    });
    const id = mgr.createSession("t").id;
    store.appendSessionLog(id, { ts: "1", type: "user", content: "hi" });
    const log = mgr.loadSessionLog(id);
    expect(log).toHaveLength(1);
    expect(log[0].type).toBe("user");
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/learning-session-delegate.test.ts`
Expected: FAIL — `mgr.loadSessionLog is not a function` (or TS error).

- [ ] **Step 3: Implement the delegate**

In `src/modules/session/manager.ts`, add a public method near `getSessionDirectory`:

```typescript
  /**
   * Load the detailed session log (session.jsonl) for a session id.
   * Delegates to the store so callers reuse the configured encryption.
   */
  loadSessionLog(id: string): SessionLogEntry[] {
    return this.store.loadSessionLog(id);
  }
```

`SessionLogEntry` is already imported in manager.ts (see line 2).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/learning-session-delegate.test.ts`
Expected: PASS. Verify `mgr.createSession` exists — if not, create via `store.saveMeta` instead (check manager API in Task 8 before relying on it).

- [ ] **Step 5: Commit**

```bash
git add src/modules/session/manager.ts tests/learning-session-delegate.test.ts
git commit -m "feat(learning): expose SessionManager.loadSessionLog delegate"
```

---

### Task 8: `mma learn` CLI command

**Files:**

- Create: `src/modules/learning/cli.ts`
- Create: `src/modules/learning/index.ts`
- Modify: `src/cli/commands.ts`

- [ ] **Step 1: Write the failing unit test for runLearn with injected pieces**

The CLI action is built around a small testable core. Design `runLearn` to accept an injected `SkillGenerator` factory so unit tests never touch a real provider:

```typescript
// tests/learning-cli.test.ts
import { describe, it, expect } from "vitest";
import { runLearn } from "../src/modules/learning/cli";
import type { LearningConfig } from "../src/modules/learning/types";

const cfg: LearningConfig = {
  enabled: true,
  skillGeneration: { minToolCalls: 3, minLength: 200, maxLength: 3000, targetDir: "project" },
  nudge: { enabled: true },
};

describe("runLearn flow decisions", () => {
  it("is a no-op when the session is too short (below minToolCalls)", async () => {
    const result = await runLearn({
      config: cfg,
      getSummary: () => ({ sessionId: "s", toolCallCount: 1, steps: [], errors: [] }),
      generate: async () => { throw new Error("should not be called"); },
      confirm: async () => true,
      save: async () => { throw new Error("should not be called"); },
    });
    expect(result.outcome).toBe("nothing-to-learn");
  });

  it("aborts when the user declines", async () => {
    const result = await runLearn({
      config: cfg,
      getSummary: () => ({ sessionId: "s", toolCallCount: 5, steps: [], errors: [] }),
      generate: async () => ({ name: "deploy", content: "x".repeat(300) }),
      confirm: async () => false,
      save: async () => { throw new Error("should not be called"); },
    });
    expect(result.outcome).toBe("declined");
  });

  it("saves a validated draft on confirm", async () => {
    const saved: string[] = [];
    const content = "---\nname: deploy\ndescription: deploy the app\nwhen_to_use: on release\nmma_version: 2\n---\n\n" + "Step 1: build.\n".repeat(60);
    const result = await runLearn({
      config: cfg,
      getSummary: () => ({ sessionId: "s", toolCallCount: 5, steps: [], errors: [] }),
      generate: async () => ({ name: "deploy", content }),
      confirm: async () => true,
      save: async (name, c) => { saved.push(name); expect(c).toBe(content); return true; },
    });
    expect(result.outcome).toBe("saved");
    expect(saved).toEqual(["deploy"]);
  });

  it("returns invalid when the draft fails validation", async () => {
    const result = await runLearn({
      config: cfg,
      getSummary: () => ({ sessionId: "s", toolCallCount: 5, steps: [], errors: [] }),
      generate: async () => ({ name: "Bad Name!", content: "short" }),
      confirm: async () => true,
      save: async () => { throw new Error("should not be called"); },
    });
    expect(result.outcome).toBe("invalid");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/learning-cli.test.ts`
Expected: FAIL — cannot find module `../src/modules/learning/cli`.

- [ ] **Step 3: Implement the testable core + production CLI action**

```typescript
// src/modules/learning/cli.ts
import { join } from "path";
import { homedir } from "os";
import { mkdirSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { OpenAICompatProvider } from "../../llm/openai-compat";
import { SkillGenerator } from "./generator";
import { SkillValidator } from "./validator";
import { TraceReader } from "./trace";
import type { SkillDraft, TraceSummary } from "./types";
import type { LearningConfig } from "./types";
import type { SessionManager } from "../session/manager";
import type { AppConfig } from "../../config/types";
import { t } from "../../i18n/index";

export type LearnOutcome = "saved" | "declined" | "invalid" | "nothing-to-learn" | "no-session";

export interface LearnDeps {
  getSummary: (sessionId: string) => TraceSummary | null;
  generate: (summary: TraceSummary) => Promise<SkillDraft>;
  confirm: (draft: SkillDraft) => Promise<boolean>;
  save: (name: string, content: string) => Promise<boolean>;
}

/**
 * Pure flow — unit-tested without a provider. Production wiring supplies the
 * real dependencies in runLearnCli().
 */
export async function runLearn(deps: LearnDeps): Promise<{ outcome: LearnOutcome; draft?: SkillDraft }> {
  // The session resolution happens in the production wrapper; this core
  // operates on a single resolved summary for testability.
  throw new Error("not implemented");
}
```

Wait — the test calls `runLearn` with a `config` and no session id, and the flow internally decides. Restructure so the testable core owns the whole flow:

```typescript
export interface LearnDeps {
  config: LearningConfig;
  getSummary: () => TraceSummary | null;
  generate: (summary: TraceSummary) => Promise<SkillDraft>;
  confirm: (draft: SkillDraft) => Promise<boolean>;
  save: (name: string, content: string) => Promise<boolean>;
}

export async function runLearn(deps: LearnDeps): Promise<{ outcome: LearnOutcome; draft?: SkillDraft }> {
  const summary = deps.getSummary();
  if (!summary) return { outcome: "no-session" };
  if (summary.toolCallCount < deps.config.skillGeneration.minToolCalls) {
    return { outcome: "nothing-to-learn" };
  }
  const draft = await deps.generate(summary);
  const accepted = await deps.confirm(draft);
  if (!accepted) return { outcome: "declined", draft };

  const validator = new SkillValidator([], {
    minLength: deps.config.skillGeneration.minLength,
    maxLength: deps.config.skillGeneration.maxLength,
  });
  const v = validator.validate(draft);
  if (!v.ok) return { outcome: "invalid", draft };

  await deps.save(draft.name, draft.content);
  return { outcome: "saved", draft };
}
```

Hmm — the duplicate-name check needs the existing skill list; that's a production concern. For the testable core, keep `existingNames` out and do it in the wrapper. But then `invalid` for "Bad Name!" works (name regex) and "short" body works. The `save` in the wrapper should re-validate with existing names before writing. To keep the plan honest: the core validates name/body/frontmatter with an empty existing-names list; the production wrapper adds the real existing-names check right before saving (documented below).

- [ ] **Step 4: Production wrapper — runLearnCli (session resolve → trace → generate → confirm → save)**

```typescript
// src/modules/learning/cli.ts (continued — full file)
import { join } from "path";
import { homedir } from "os";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { createInterface } from "readline";
import { OpenAICompatProvider } from "../../llm/openai-compat";
import { SkillGenerator } from "./generator";
import { SkillValidator } from "./validator";
import { TraceReader } from "./trace";
import { SkillsLoader } from "../skills/loader";
import type { SkillDraft, TraceSummary, LearningConfig } from "./types";
import type { AppConfig } from "../../config/types";
import type { SessionManager } from "../session/manager";

export interface RunLearnCliOptions {
  config: AppConfig;
  sessionManager: SessionManager;
  baseDir: string;
  sessionId?: string;
  global?: boolean;
  prompt?: (question: string) => Promise<string>; // injected for tests
}

export async function runLearnCli(opts: RunLearnCliOptions): Promise<{ outcome: LearnOutcome; draft?: SkillDraft }> {
  const lc = opts.config.learning ?? DEFAULT_LRN;
  const targetDir =
    opts.global === true
      ? join(homedir(), ".agents", "skills")
      : lc.skillGeneration.targetDir === "global"
        ? join(homedir(), ".agents", "skills")
        : join(opts.baseDir, ".mma", "skills");

  const deps: LearnDeps = {
    config: lc,
    getSummary: () => {
      const sessions = opts.sessionManager.list();
      if (sessions.length === 0) return null;
      const id = opts.sessionId ?? sessions[0].id; // list() is sorted newest-first
      if (opts.sessionId && !sessions.some((s) => s.id === opts.sessionId)) return null;
      const reader = new TraceReader(opts.sessionManager as unknown as { loadSessionLog(id: string): unknown[] });
      return reader.summarize(id);
    },
    generate: async (summary) => {
      const provider = new OpenAICompatProvider({
        model: opts.config.model,
        baseUrl: opts.config.provider.baseUrl,
        apiKey: opts.config.provider.apiKey,
        contextWindow: opts.config.contextWindow,
        retry: opts.config.retry,
        rateLimits: opts.config.security?.rateLimits,
      });
      const gen = new SkillGenerator(
        { model: opts.config.model, baseUrl: opts.config.provider.baseUrl, apiKey: opts.config.provider.apiKey, contextWindow: opts.config.contextWindow },
        provider,
      );
      return gen.generate(summary);
    },
    confirm: async (draft) => {
      const answer = await askConfirm(
        `\n${draft.content}\n\nSave as skill "${draft.name}"? [y/N] `,
        opts.prompt,
      );
      return answer;
    },
    save: async (name, content) => {
      // Duplicate check against all existing skills (builtin + global + project)
      const loader = new SkillsLoader();
      const existing = loader.loadFromAllSources(
        join(import.meta.dirname, "..", "..", "skills", "builtin"),
        join(homedir(), ".agents", "skills"),
        join(opts.baseDir, ".mma", "skills"),
      );
      if (existing.some((s) => s.name === name)) return false;
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, `${name}.md`), content, "utf-8");
      return true;
    },
  };

  const result = await runLearn(deps);
  return result;
}
```

The type cast on `sessionManager` exists only because `TraceReader` expects the narrow store interface — fix by typing `TraceReader`'s constructor against an interface `{ loadSessionLog(id: string): SessionLogEntry[] }` instead of `SessionStore`. Update Task 2's `trace.ts` accordingly:

```typescript
// In trace.ts: constructor accepts any object with loadSessionLog
export interface SessionLogSource {
  loadSessionLog(id: string): SessionLogEntry[];
}
export class TraceReader {
  constructor(private store: SessionLogSource) {}
```

(Add this in Task 2 as an amendment — the SessionStore and SessionManager both satisfy `SessionLogSource`, so no casts needed anywhere.)

For `askConfirm` + `DEFAULT_LRN` helpers:

```typescript
function askConfirm(question: string, injected?: (q: string) => Promise<string>): Promise<boolean> {
  if (injected) return injected(question).then((a) => /^y/i.test(a.trim()));
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y/i.test(answer.trim()));
    });
  });
}

const DEFAULT_LRN: LearningConfig = {
  enabled: false,
  skillGeneration: { minToolCalls: 3, minLength: 200, maxLength: 3000, targetDir: "project" },
  nudge: { enabled: true },
};
```

- [ ] **Step 5: Export index**

```typescript
// src/modules/learning/index.ts
export { TraceReader } from "./trace";
export { SkillGenerator } from "./generator";
export { SkillValidator } from "./validator";
export { LearningModule } from "./module";
export { runLearn, runLearnCli, type LearnOutcome, type LearnDeps } from "./cli";
export type { TraceSummary, TraceStep, SkillDraft, ValidationResult, LearningConfig } from "./types";
```

- [ ] **Step 6: Wire the CLI command in commands.ts**

In `src/cli/commands.ts`, add after the `context` command (matching the `model certify` dynamic-import pattern):

```typescript
 const learn = program
  .command("learn")
  .description(t("cli.learn"))
  .option("--session <id>", t("cli.learn_session"))
  .option("--global", t("cli.learn_global"))
  .action(async (cmdOpts: any) => {
   const { config, sessionManager, baseDir } = await bootstrap();
   const { runLearnCli } = await import("../modules/learning/cli");
   const result = await runLearnCli({
    config,
    sessionManager,
    baseDir,
    sessionId: cmdOpts.session,
    global: cmdOpts.global === true,
   });
   switch (result.outcome) {
    case "saved":
     console.log(t("cli.learn_saved", { name: result.draft?.name ?? "" }));
     break;
    case "declined":
     console.log(t("cli.learn_declined"));
     break;
    case "invalid":
     console.log(t("cli.learn_invalid"));
     process.exitCode = 1;
     break;
    case "nothing-to-learn":
     console.log(t("cli.learn_nothing"));
     break;
    case "no-session":
     console.log(t("cli.learn_no_session"));
     process.exitCode = 1;
     break;
   }
  });
```

- [ ] **Step 7: Run unit tests + typecheck**

Run: `bun test tests/learning-cli.test.ts && tsc --noEmit`
Expected: PASS / no errors.

- [ ] **Step 8: Commit**

```bash
git add src/modules/learning/cli.ts src/modules/learning/index.ts src/cli/commands.ts tests/learning-cli.test.ts
git commit -m "feat(learning): add mma learn CLI command"
```

---

### Task 9: i18n strings

**Files:**

- Modify: `src/i18n/en.json`
- Modify: `src/i18n/ru.json`

- [ ] **Step 1: Add keys to en.json**

Inside the `cli` object (match existing structure — keys are nested, e.g. `"cli": { "learn": ..., ... }`):

```json
    "cli.learn": "Learn a reusable skill from the last session",
    "cli.learn_session": "Session id to learn from (default: last session)",
    "cli.learn_global": "Save the skill to the global skills dir (~/.agents/skills)",
    "cli.learn_saved": "Skill saved: {name}",
    "cli.learn_declined": "Skipped — skill not saved",
    "cli.learn_invalid": "Draft failed validation — not saved",
    "cli.learn_nothing": "Nothing to learn from this session (too few tool calls)",
    "cli.learn_no_session": "No session found"
```

- [ ] **Step 2: Add matching keys to ru.json**

```json
    "cli.learn": "Извлечь переиспользуемый навык из последней сессии",
    "cli.learn_session": "ID сессии для разбора (по умолчанию: последняя)",
    "cli.learn_global": "Сохранить навык в глобальную папку скилов (~/.agents/skills)",
    "cli.learn_saved": "Навык сохранён: {name}",
    "cli.learn_declined": "Пропущено — навык не сохранён",
    "cli.learn_invalid": "Черновик не прошёл валидацию — не сохранён",
    "cli.learn_nothing": "Нечему учиться: в сессии слишком мало вызовов инструментов",
    "cli.learn_no_session": "Сессия не найдена"
```

- [ ] **Step 3: Verify parity + typecheck**

Run:

```bash
python -c "
import json
en = json.load(open('src/i18n/en.json', encoding='utf-8'))
ru = json.load(open('src/i18n/ru.json', encoding='utf-8'))
def flat(d, p=''):
    for k, v in d.items():
        fk = f'{p}.{k}' if p else k
        if isinstance(v, dict): yield from flat(v, fk)
        else: yield fk
ek, rk = set(flat(en)), set(flat(ru))
assert ek == rk, f'MISMATCH: {ek ^ rk}'
print('i18n parity OK')
"
```

Expected: `i18n parity OK`. Then `tsc --noEmit` — PASS.

- [ ] **Step 4: Commit**

```bash
git add src/i18n/en.json src/i18n/ru.json
git commit -m "feat(learning): i18n strings (en/ru parity)"
```

---

### Task 10: AGENTS.md + integration verification

**Files:**

- Modify: `AGENTS.md`
- Create: `_testing/learning/README.md` (manual test notes)

- [ ] **Step 1: Add the Self-Learning section to AGENTS.md**

Insert a new `## Self-Learning (learning module)` section after the `## Model Certification` section (keep it concise, ~15 lines):

```markdown
## Self-Learning (learning module)

> **Spec:** `docs/specs/2026-08-11-self-learning-design.md` — Phase 1 (skills) implemented, Phase 2 (gated error learning) design-only.

Turns successful sessions into reusable SKILL.md files. Opt-in: `learning.enabled: true`.

- **`mma learn`** — nudge: reads the last session (`--session <id>` to pick), compacts the trace deterministically (`TraceReader`, no LLM), makes ONE LLM call (`SkillGenerator`) to draft a SKILL.md, asks for confirmation, validates (`SkillValidator`: frontmatter, name slug, length, duplicates), and saves to `<project>/.mma/skills/` (or `~/.agents/skills` with `--global`). Already-loaded skills are picked up immediately by the existing L1/L2/L3 loader.
- **Auto-suggestion** — when enabled, a low-priority system-prompt directive tells the model to suggest saving a reusable procedure at the end of a session. The model never saves on its own.
- **Budget:** 1 LLM call per nudge; sessions under `learning.skillGeneration.minToolCalls` tool calls are skipped before any LLM call.
- **Source:** `src/modules/learning/` (`trace.ts`, `generator.ts`, `validator.ts`, `module.ts`, `cli.ts`).
```

- [ ] **Step 2: Manual integration check (requires a live provider)**

```bash
# 1. Run a multi-step task in a sandbox
bun run mma "create hello.ts with a greet function, then a test, then run it" \
  --no-agents-md --exit-on-complete -d _testing/learning/

# 2. Learn from the session it created
bun run mma learn --session <id-from-step-1>

# 3. Expect: trace shown, draft SKILL.md, y/N prompt
# 4. Confirm → file appears in _testing/learning/.mma/skills/<name>.md
```

Record what you observe in `_testing/learning/README.md` (draft quality, name, validation warnings). Do not commit `_testing/` (it is gitignored).

- [ ] **Step 3: Full verification**

Run: `bun test && tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs: document self-learning module in AGENTS.md"
```

---

## Self-Review (run before execution handoff)

**1. Spec coverage (Phase 1):**

- `mma learn` CLI ✓ (Task 8), auto-suggestion directive ✓ (Task 6), TraceReader ✓ (Task 2), SkillGenerator ✓ (Task 4), SkillValidator ✓ (Task 3), config opt-in ✓ (Task 5), i18n parity ✓ (Task 9), budget: no LLM under minToolCalls ✓ (Task 8 flow), save to project/global skills ✓ (Task 8), progressive disclosure pickup ✓ (existing SkillsLoader, Task 10).
- Phase 2 is intentionally NOT implemented (design-only in spec) ✓.

**2. Placeholder scan:** No TBD/TODO; every code step has full code. The Task 8 `runLearn` core went through two iterations in the plan text — the final version (with `LearnDeps` owning the flow) is the one to implement; ignore the first rejected sketch.

**3. Type consistency:** `TraceSummary`/`SkillDraft`/`ValidationResult`/`LearningConfig` names are consistent across tasks. `TraceReader` constructor takes `SessionLogSource` (amended in Task 8) — Task 2's test passes a `SessionStore` which satisfies it. `runLearn` returns `{ outcome, draft? }` everywhere the tests assert. `SkillGenerator` takes `(GeneratorOptions, LLMProvider)` — the CLI passes a real `OpenAICompatProvider`.

**Known risk to check at implementation:** `SessionManager.createSession` return shape in Task 7's test — if the manager API differs (e.g. returns id string, not object), adjust the test to the actual shape before relying on it.
