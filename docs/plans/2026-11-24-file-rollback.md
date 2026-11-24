# File Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent a deterministic undo for file-tool edits: per-file LIFO steps and whole-turn rollback, stored in the session directory.

**Architecture:** A `FileChangesPort` is exposed on `ToolContext` by both context builders; `ToolExecutor.execute()` captures a file's bytes synchronously before the handler and commits a journal entry after success. A non-critical `src/modules/changes/` module owns the append-only `index.jsonl`, gzip content-addressed blobs, budget/eviction, and undo logic. Two tools (`list_file_changes`, `restore_file`), `mma undo`, and `/undo` call the same port; bash edits are explicitly out of scope.

**Tech Stack:** Bun 1.3, TypeScript strict/NodeNext, `node:fs`, `node:zlib`, `node:crypto`, commander, Bun test, Biome, i18n `t()` with en/ru JSON.

**Spec:** `docs/specs/2026-11-24-file-rollback-design.md` (approved).

---

## File structure

| File | Responsibility |
|---|---|
| `src/modules/changes/types.ts` | `ChangeEntry`, `UndoResult`, option types (no imports from tools) |
| `src/modules/changes/store.ts` | journal, blobs, state, encryption, eviction |
| `src/modules/changes/capture.ts` | tool→op table, before/after capture, fail-open diagnostics |
| `src/modules/changes/undo.ts` | list/undo semantics, conflict checks, session-log event |
| `src/modules/changes/index.ts` | `createFileChangesPort()` factory |
| `src/tools/types.ts` | `FileChangesPort` interface + `ToolContext.fileChanges` |
| `src/tools/executor.ts` | two capture calls, one execution point |
| `src/tools/restore-file.ts`, `src/tools/list-file-changes.ts` | new tools |
| `src/tools/index.ts` | register the two tools |
| `src/core/bootstrap/tool-context.ts`, `session-runner-scope.ts`, `session-phase.ts`, `session-runner.ts` | port wiring in both ToolContext builders |
| `src/core/agent/turn-run.ts` | `beginTurn(sessionId)` at turn boundary |
| `src/config/*`, `src/i18n/*.json`, `src/modules/webui/assets/js/settings/controls.ts` | config keys, labels, panel |
| `src/cli/undo-command.ts`, `src/cli/repl-commands-session.ts`, `src/cli/commands.ts`, `src/core/commands/spec.ts` | CLI + slash surface |
| `tests/changes/*.test.ts`, `tests/arch/changes-coverage.test.ts`, `tests/cli/undo.test.ts` | tests |

Rule: every file stays ≤300 lines (`.arch-allowlist.json` must remain empty). Modules never import `core/agent/*` and never call `tool.handler`.

---

### Task 1: Config domain `changes` and gates

**Files:**
- Modify: `src/config/types.ts` (~line 121), `src/config/defaults.ts` (~line 101), `src/config/registry-extra-features.ts` (end of `FEATURE_DEFS`), `src/config/domains.ts` (~line 57), `tests/config-domains.test.ts` (~line 44)
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`, `src/modules/webui/assets/js/settings/controls.ts` (~line 260)
- Test: `tests/changes/config.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// tests/changes/config.test.ts
import { describe, expect, it } from "bun:test";
import { DEFAULTS } from "../../src/config/defaults";
import { configDefs } from "../../src/config/registry";
import { CONFIG_DOMAINS } from "../../src/config/domains";

describe("changes config", () => {
  it("declares defaults once", () => {
    expect(DEFAULTS.changes).toEqual({
      enabled: true,
      maxFileBytes: 2_097_152,
      maxTotalBytes: 67_108_864,
      maxRevisionsPerFile: 20,
    });
  });

  it("registers all four keys with no effects", () => {
    const keys = ["changes.enabled", "changes.maxFileBytes", "changes.maxTotalBytes", "changes.maxRevisionsPerFile"];
    for (const key of keys) {
      const def = configDefs().find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.domain).toBe("changes");
      expect(def!.effects).toEqual([]);
      expect(def!.get(structuredClone(DEFAULTS))).toBe(
        (DEFAULTS.changes as Record<string, unknown>)[key.split(".")[1]!],
      );
    }
  });

  it("persists the changes domain", () => {
    expect(CONFIG_DOMAINS.changes).toEqual(["changes"]);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

`bun test tests/changes/config.test.ts tests/config-domains.test.ts`
Expected: FAIL — `DEFAULTS.changes` undefined, domain count still 18.

- [ ] **Step 3: Add type, defaults, registry, domains**

In `src/config/types.ts`, after the `hitl` field:

```ts
  /** Откат правок file-тулов: снапшоты в папке сессии. */
  changes?: {
    enabled?: boolean;
    maxFileBytes?: number;
    maxTotalBytes?: number;
    maxRevisionsPerFile?: number;
  };
```

In `src/config/defaults.ts`, after `hitl: …`:

```ts
  changes: {
    enabled: true,
    maxFileBytes: 2_097_152,
    maxTotalBytes: 67_108_864,
    maxRevisionsPerFile: 20,
  },
```

Append to `FEATURE_DEFS` in `src/config/registry-extra-features.ts` (before the closing `];`):

```ts
  bool("changes.enabled", "changes", false,
    (c) => c.changes?.enabled ?? DEFAULTS.changes!.enabled!,
    (c, v) => {
      c.changes ??= structuredClone(DEFAULTS.changes!);
      c.changes.enabled = v as boolean;
    }),
  int("changes.maxFileBytes", "changes", 1024, 20_971_520, 1024, false,
    (c) => c.changes?.maxFileBytes ?? DEFAULTS.changes!.maxFileBytes!,
    (c, v) => {
      c.changes ??= structuredClone(DEFAULTS.changes!);
      c.changes.maxFileBytes = v as number;
    }),
  int("changes.maxTotalBytes", "changes", 1_048_576, 536_870_912, 1_048_576, false,
    (c) => c.changes?.maxTotalBytes ?? DEFAULTS.changes!.maxTotalBytes!,
    (c, v) => {
      c.changes ??= structuredClone(DEFAULTS.changes!);
      c.changes.maxTotalBytes = v as number;
    }),
  int("changes.maxRevisionsPerFile", "changes", 1, 200, 1, false,
    (c) => c.changes?.maxRevisionsPerFile ?? DEFAULTS.changes!.maxRevisionsPerFile!,
    (c, v) => {
      c.changes ??= structuredClone(DEFAULTS.changes!);
      c.changes.maxRevisionsPerFile = v as number;
    }),
```

In `src/config/domains.ts`, add `changes: ["changes"],` next to the last domain; in `tests/config-domains.test.ts` change `toHaveLength(18)` to `toHaveLength(19)`.

- [ ] **Step 4: Add symmetric i18n labels and web panel placement**

Insert in BOTH `src/i18n/en.json` and `src/i18n/ru.json` (2-space indent, preserve CRLF — use the edit tool, not a full-file rewrite):

```json
  "config.key.changes.enabled": "file rollback snapshots",
  "config.desc.changes.enabled": "Keep a copy of the file before every file-tool edit so the agent can undo it.",
  "config.key.changes.maxFileBytes": "max snapshot file size",
  "config.desc.changes.maxFileBytes": "Files larger than this are not snapshotted.",
  "config.key.changes.maxTotalBytes": "snapshot budget per session",
  "config.desc.changes.maxTotalBytes": "Oldest snapshots are evicted when this budget is exceeded.",
  "config.key.changes.maxRevisionsPerFile": "undo depth per file",
  "config.desc.changes.maxRevisionsPerFile": "How many previous versions of one file remain undoable.",
```

Russian values must be natural Russian with identical interpolation placeholders (none in these keys). Add the four keys to exactly ONE existing `keys: [...]` array in `src/modules/webui/assets/js/settings/controls.ts` (e.g. the `general.agent` section) — no new `web.settings.sec.*` keys.

- [ ] **Step 5: Run gates and commit**

`bun test tests/changes/config.test.ts tests/config-domains.test.ts tests/i18n.test.ts tests/webui-config-extra.test.ts tests/webui-i18n.test.ts`
Expected: PASS.
`git add src/config tests/changes/config.test.ts tests/config-domains.test.ts src/i18n src/modules/webui/assets/js/settings/controls.ts && git commit -m "feat(changes): config domain and i18n labels"`

---

### Task 2: Changes types and journal store

**Files:**
- Create: `src/modules/changes/types.ts`, `src/modules/changes/store.ts`
- Test: `tests/changes/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/changes/store.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import { ChangesStore } from "../../src/modules/changes/store";
import type { ChangeEntry } from "../../src/modules/changes/types";

let root: string;
let store: ChangesStore;
const config = structuredClone(DEFAULTS) as AppConfig;

const entry = (over: Partial<ChangeEntry> = {}): ChangeEntry => ({
  v: 1, id: `ch_${Math.random().toString(36).slice(2)}`, ts: new Date().toISOString(),
  turn: 1, tool: "write_file", callId: "c1", op: "write", path: "a.txt",
  pathAbs: join(root, "a.txt"), before: null, after: "sha", bytes: 3, ...over,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mma-changes-"));
  store = new ChangesStore({
    sessionManager: { getSessionDirectory: () => join(root, "sessions", "s1") },
    getConfig: () => config,
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ChangesStore", () => {
  it("appends entries and deduplicates blobs", () => {
    const a = store.putBlob("s1", Buffer.from("hello"));
    const b = store.putBlob("s1", Buffer.from("hello"));
    expect(a).toBe(b);
    expect(store.getBlob("s1", a)!.toString()).toBe("hello");
    store.append("s1", entry({ before: a, after: a }));
    expect(store.readEntries("s1")).toHaveLength(1);
    expect(store.readEntries("s1")[0]!.path).toBe("a.txt");
  });

  it("keeps a monotonic turn counter across recreated stores", () => {
    expect(store.nextTurn("s1")).toBe(1);
    expect(new ChangesStore({
      sessionManager: { getSessionDirectory: () => join(root, "sessions", "s1") },
      getConfig: () => config,
    }).nextTurn("s1")).toBe(2);
  });

  it("skips broken journal lines and decrypts when encryption is on", () => {
    const dir = join(root, "sessions", "s1", "changes");
    store.append("s1", entry());
    const path = join(dir, "index.jsonl");
    writeFileSync(path, `${readFileSync(path, "utf8")}not-json\n`);
    expect(store.readEntries("s1")).toHaveLength(1);

    const enc = structuredClone(DEFAULTS) as AppConfig;
    enc.security!.sessionEncryption = {
      enabled: true, encryptHistory: true, encryptSessionLog: true,
      keyPath: join(root, ".session-encryption-key"),
    };
    const encrypted = new ChangesStore({
      sessionManager: { getSessionDirectory: () => join(root, "sessions", "s1") },
      getConfig: () => enc,
    });
    encrypted.append("s1", entry({ id: "ch_enc", path: "b.txt" }));
    expect(encrypted.readEntries("s1").some((e) => e.id === "ch_enc")).toBe(true);
    expect(existsSync(join(dir, "state.json"))).toBe(false); // turns not started here
  });
});
```

- [ ] **Step 2: Run it and see it fail**

`bun test tests/changes/store.test.ts` → FAIL: module not found.

- [ ] **Step 3: Implement types and store**

`src/modules/changes/types.ts`:

```ts
export type ChangeOp = "write" | "delete" | "move" | "undo" | "evicted";

export interface ChangeEntry {
  v: 1;
  id: string;
  ts: string;
  turn: number;
  tool: string;
  callId: string;
  op: ChangeOp;
  path: string;
  pathAbs: string;
  before: string | null;
  after: string | null;
  bytes: number;
  mode?: number;
  to?: string;
  toBefore?: string | null;
  targetId?: string;
  skipped?: "too-large" | "evicted" | "unsupported";
}

export interface UndoItem {
  path: string;
  ok: boolean;
  reason?: string;
}

export interface UndoResult {
  ok: boolean;
  message: string;
  items: UndoItem[];
  diff?: string;
}

export interface ListOptions {
  sessionId: string;
  baseDir: string;
  path?: string;
  limit?: number;
}

export interface UndoOptions {
  sessionId: string;
  baseDir: string;
  path?: string;
  steps?: number;
  turn?: number;
  force?: boolean;
}
```

`src/modules/changes/store.ts` (all paths derived from SessionManager; encryptor built from live config; gzip+base64 blobs are self-describing via `SessionFileEncryptor.decryptFileContent`):

```ts
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AppConfig } from "../../config/types";
import { SessionFileEncryptor } from "../security/session-encryption";
import type { ChangeEntry } from "./types";

export interface ChangesStoreDeps {
  sessionManager: { getSessionDirectory(id: string): string };
  getConfig: () => AppConfig;
}

export class ChangesStore {
  constructor(private readonly deps: ChangesStoreDeps) {}

  dir(sessionId: string): string {
    return join(this.deps.sessionManager.getSessionDirectory(sessionId), "changes");
  }

  private enc(): SessionFileEncryptor {
    return new SessionFileEncryptor(this.deps.getConfig().security?.sessionEncryption);
  }

  private index(sessionId: string): string { return join(this.dir(sessionId), "index.jsonl"); }
  private state(sessionId: string): string { return join(this.dir(sessionId), "state.json"); }
  private blob(sessionId: string, sha: string): string {
    return join(this.dir(sessionId), "blobs", sha.slice(0, 2), `${sha}.gz`);
  }
  private ensure(sessionId: string): void {
    mkdirSync(join(this.dir(sessionId), "blobs"), { recursive: true });
  }

  readEntries(sessionId: string): ChangeEntry[] {
    const file = this.index(sessionId);
    if (!existsSync(file)) return [];
    const lines = this.enc().decryptJSONL(readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean));
    const out: ChangeEntry[] = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as ChangeEntry;
        if (e.v === 1 && typeof e.id === "string" && typeof e.op === "string") out.push(e);
      } catch { /* битая строка — пропуск, как в session.jsonl */ }
    }
    return out;
  }

  append(sessionId: string, entry: ChangeEntry): void {
    this.ensure(sessionId);
    appendFileSync(this.index(sessionId), `${this.enc().encryptFileContent(JSON.stringify(entry))}\n`, "utf8");
  }

  putBlob(sessionId: string, content: Buffer): string {
    const sha = createHash("sha256").update(content).digest("hex");
    const file = this.blob(sessionId, sha);
    if (!existsSync(file)) {
      this.ensure(sessionId);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, this.enc().encryptFileContent(gzipSync(content).toString("base64")), "utf8");
    }
    return sha;
  }

  getBlob(sessionId: string, sha: string | null): Buffer | null {
    if (!sha) return null;
    const file = this.blob(sessionId, sha);
    if (!existsSync(file)) return null;
    const body = this.enc().decryptFileContent(readFileSync(file, "utf8"));
    return gunzipSync(Buffer.from(body, "base64"));
  }

  loadTurn(sessionId: string): number {
    const file = this.state(sessionId);
    if (!existsSync(file)) return 0;
    try {
      const raw = this.enc().decryptFileContent(readFileSync(file, "utf8"));
      const state = JSON.parse(raw) as { v: 1; turn: number };
      return state.v === 1 && Number.isInteger(state.turn) ? state.turn : 0;
    } catch { return 0; }
  }

  nextTurn(sessionId: string): number {
    const turn = this.loadTurn(sessionId) + 1;
    this.ensure(sessionId);
    const file = this.state(sessionId);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, this.enc().encryptFileContent(JSON.stringify({ v: 1, turn })), "utf8");
    renameSync(tmp, file);
    return turn;
  }
}
```

Note: `decryptJSONL` already tolerates bad lines; the extra `try/catch` handles plaintext garbage when encryption is off.

- [ ] **Step 4: Run tests and commit**

`bun test tests/changes/store.test.ts` → PASS.
`git add src/modules/changes tests/changes/store.test.ts && git commit -m "feat(changes): journal store with blobs and encryption"`

---

### Task 3: Capture (before/after) and coverage gate

**Files:**
- Create: `src/modules/changes/capture.ts`, `tests/arch/changes-coverage.test.ts`
- Test: `tests/changes/capture.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/changes/capture.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import type { ToolContext, ToolDefinition } from "../../src/tools/types";
import { ChangeCapture } from "../../src/modules/changes/capture";
import { ChangesStore } from "../../src/modules/changes/store";

let root: string;
let store: ChangesStore;
let capture: ChangeCapture;
const diags: unknown[] = [];
const config = structuredClone(DEFAULTS) as AppConfig;
const baseDir = join(tmpdir(), "mma-workspace-fake");

const tool = (name: string): ToolDefinition => ({
  name, description: "", parameters: {}, security: { caps: [{ fs: "write" }] },
});
const ctx = (): ToolContext => ({
  config, baseDir, logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
  sessionId: "s1", exitOnComplete: true, contextManager: {} as never, activeToolTags: [],
  onDiagnostic: (d) => diags.push(d),
} as unknown as ToolContext);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mma-capture-"));
  diags.length = 0;
  store = new ChangesStore({
    sessionManager: { getSessionDirectory: () => join(root, "sessions", "s1") },
    getConfig: () => config,
  });
  capture = new ChangeCapture(store, config, (d) => diags.push(d));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ChangeCapture", () => {
  it("snapshots content before an edit and records it after success", () => {
    const file = join(root, "a.txt");
    writeFileSync(file, "old");
    const c = ctx();
    capture.before({ ...c, baseDir: root }, tool("write_file"), {
      id: "call1", name: "write_file", arguments: { path: "a.txt" },
    });
    writeFileSync(file, "new");
    capture.after("call1", true);
    const e = store.readEntries("s1")[0]!;
    expect(e.op).toBe("write");
    expect(store.getBlob("s1", e.before)!.toString()).toBe("old");
    expect(store.getBlob("s1", e.after)!.toString()).toBe("new");
    expect(diags).toHaveLength(0);
  });

  it("does not journal a failed write and stays fail-open", () => {
    const c = ctx();
    capture.before({ ...c, baseDir: root }, tool("write_file"), {
      id: "call2", name: "write_file", arguments: { path: "missing.txt" },
    });
    capture.after("call2", false);
    expect(store.readEntries("s1")).toHaveLength(0);
    expect(diags).toHaveLength(0);
  });

  it("records delete and move with both sides", () => {
    const file = join(root, "m.txt");
    writeFileSync(file, "data");
    const c = { ...ctx(), baseDir: root };
    capture.before(c, tool("delete_file"), {
      id: "d1", name: "delete_file", arguments: { path: "m.txt" },
    });
    capture.after("d1", true);
    writeFileSync(file, "data");
    capture.before(c, tool("move_file"), {
      id: "m1", name: "move_file", arguments: { from: "m.txt", to: "n.txt" },
    });
    writeFileSync(join(root, "n.txt"), "data");
    capture.after("m1", true);
    const [del, move] = store.readEntries("s1");
    expect(del!.op).toBe("delete");
    expect(del!.after).toBeNull();
    expect(move!.op).toBe("move");
    expect(move!.to).toBe("n.txt");
    expect(move!.toBefore).toBeNull();
  });
});
```

Coverage gate (`tests/arch/changes-coverage.test.ts`) — must fail before capture.ts exists with a clear message, then pass:

```ts
import { describe, expect, it } from "bun:test";
import { OP_BY_TOOL, EXCLUDED_TOOLS } from "../../src/modules/changes/capture";
import { registerAllTools } from "../../src/tools/index";
import { ToolRegistry } from "../../src/tools/registry";

describe("file-tool snapshot coverage", () => {
  it("covers or explicitly excludes every fs-write tool with pathArgs", () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const writers = registry.getAll().filter((tool) =>
      tool.security.pathArgs?.length &&
      tool.security.caps.some((cap) => cap.fs === "write" || cap.fs === "any"),
    );
    expect(writers.length).toBeGreaterThan(0);
    for (const tool of writers) {
      expect(OP_BY_TOOL[tool.name] ?? EXCLUDED_TOOLS[tool.name]).toBeTruthy();
    }
  });

  it("documents exclusions with a reason", () => {
    expect(EXCLUDED_TOOLS.create_dir).toBeTruthy();
    expect(EXCLUDED_TOOLS.bash).toBeTruthy();
    expect(EXCLUDED_TOOLS.restore_file).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests, see them fail**

`bun test tests/changes/capture.test.ts tests/arch/changes-coverage.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement capture**

`src/modules/changes/capture.ts`:

```ts
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { AppConfig } from "../../config/types";
import type { Diagnostic } from "../../output/types";
import { isInsideDir, safeResolvePath } from "../../tools/path-utils";
import type { ToolCall, ToolContext, ToolDefinition } from "../../tools/types";
import { ChangesStore } from "./store";
import type { ChangeEntry, ChangeOp } from "./types";

export const OP_BY_TOOL: Record<string, { op: ChangeOp; pathArg: string; toArg?: string }> = {
  write_file: { op: "write", pathArg: "path" },
  edit_file: { op: "write", pathArg: "path" },
  patch_file: { op: "write", pathArg: "path" },
  append_file: { op: "write", pathArg: "path" },
  download_file: { op: "write", pathArg: "path" },
  delete_file: { op: "delete", pathArg: "path" },
  move_file: { op: "move", pathArg: "from", toArg: "to" },
};

export const EXCLUDED_TOOLS: Record<string, string> = {
  create_dir: "directory creation has no file content to snapshot",
  bash: "no pathArgs; shell mutations cannot be attributed reliably",
  restore_file: "undo writes are journaled as undo markers, not edit revisions",
};

interface Pending {
  sessionId: string;
  entry: Omit<ChangeEntry, "after" | "bytes">;
  afterPathAbs: string | null;
  toPathAbs: string | null;
  onDiagnostic?: (d: Diagnostic) => void;
}

const shaOf = (store: ChangesStore, sessionId: string, pathAbs: string | null): string | null => {
  if (!pathAbs || !existsSync(pathAbs)) return null;
  return store.putBlob(sessionId, readFileSync(pathAbs));
};

export class ChangeCapture {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly store: ChangesStore,
    private readonly getConfig: () => AppConfig,
    private readonly onDiagnostic?: (d: Diagnostic) => void,
  ) {}

  before(ctx: ToolContext, tool: ToolDefinition, call: ToolCall): void {
    try {
      const plan = OP_BY_TOOL[call.name];
      if (!plan || !ctx.sessionId || this.getConfig().changes?.enabled === false) return;
      const base = resolve(ctx.baseDir);
      const path = String(call.arguments[plan.pathArg] ?? "");
      if (!path) return;
      const pathAbs = safeResolvePath(base, path);
      if (!isInsideDir(pathAbs, base)) return; // путь уже проверен enforcement’ом
      const link = lstatSync(pathAbs, { throwIfNoEntry: false });
      if (link?.isSymbolicLink()) {
        this.pending.set(call.id, {
          sessionId: ctx.sessionId,
          entry: this.baseEntry(call, plan.op, path, pathAbs, null, "unsupported"),
          afterPathAbs: null, toPathAbs: null, onDiagnostic: ctx.onDiagnostic,
        });
        return;
      }
      const stat = statSync(pathAbs, { throwIfNoEntry: false });
      const tooBig = !!stat && stat.size > (this.getConfig().changes?.maxFileBytes ?? 2_097_152);
      if (tooBig) {
        this.pending.set(call.id, {
          sessionId: ctx.sessionId,
          entry: this.baseEntry(call, plan.op, path, pathAbs, null, "too-large"),
          afterPathAbs: null, toPathAbs: null, onDiagnostic: ctx.onDiagnostic,
        });
        return;
      }
      const before = stat ? shaOf(this.store, ctx.sessionId, pathAbs) : null;
      const mode = stat?.mode;
      const toPathAbs = plan.toArg ? safeResolvePath(base, String(call.arguments[plan.toArg] ?? "")) : null;
      if (toPathAbs && !isInsideDir(toPathAbs, base)) return;
      const toBefore = toPathAbs && existsSync(toPathAbs) ? shaOf(this.store, ctx.sessionId, toPathAbs) : null;
      this.pending.set(call.id, {
        sessionId: ctx.sessionId,
        entry: { ...this.baseEntry(call, plan.op, path, pathAbs, before, undefined), ...(mode !== undefined ? { mode } : {}), ...(plan.toArg && toPathAbs ? { to: relative(base, toPathAbs), toBefore } : {}) },
        afterPathAbs: plan.op === "delete" ? null : pathAbs,
        toPathAbs,
        onDiagnostic: ctx.onDiagnostic,
      });
    } catch (err) {
      this.report("changes.capture.before", err, ctx.onDiagnostic);
    }
  }

  after(callId: string, success: boolean): void {
    const p = this.pending.get(callId);
    this.pending.delete(callId);
    if (!p || !success) return;
    try {
      const sessionId = p.sessionId;
      const after = shaOf(this.store, sessionId, p.afterPathAbs);
      const bytes = p.afterPathAbs && existsSync(p.afterPathAbs) ? statSync(p.afterPathAbs).size : 0;
      this.store.append(sessionId, {
        ...p.entry,
        turn: this.store.loadTurn(sessionId) || 1,
        after,
        bytes,
      });
    } catch (err) {
      this.report("changes.capture.after", err, p.onDiagnostic);
    }
  }

  private baseEntry(
    call: ToolCall, op: ChangeOp, path: string, pathAbs: string,
    before: string | null, skipped: ChangeEntry["skipped"],
  ): Omit<ChangeEntry, "after" | "bytes"> {
    return {
      v: 1, id: `ch_${Date.now()}_${call.id}`, ts: new Date().toISOString(),
      turn: 0, tool: call.name, callId: call.id, op, path, pathAbs, before,
      ...(skipped ? { skipped } : {}),
    };
  }

  private report(operation: string, err: unknown, sink?: (d: Diagnostic) => void): void {
    const diag: Diagnostic = {
      source: "module:changes", operation, kind: "failed",
      cause: err instanceof Error ? err.message : String(err), recoverable: true,
    };
    (sink ?? this.onDiagnostic)?.(diag);
  }
}
```

- [ ] **Step 4: Run tests, coverage gate, typecheck**

`bun test tests/changes/capture.test.ts tests/arch/changes-coverage.test.ts` → PASS.
`bun run typecheck` → PASS.
`git add src/modules/changes/capture.ts tests/changes/capture.test.ts tests/arch/changes-coverage.test.ts && git commit -m "feat(changes): capture file mutations and coverage gate"`

---

### Task 4: Eviction and undo semantics

**Files:**
- Modify: `src/modules/changes/store.ts` (add `evict()`), `src/modules/changes/capture.ts` (use `loadTurn`)
- Create: `src/modules/changes/undo.ts`
- Test: `tests/changes/undo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/changes/undo.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import { ChangesStore } from "../../src/modules/changes/store";
import { ChangeUndo } from "../../src/modules/changes/undo";
import type { ChangeEntry } from "../../src/modules/changes/types";

let root: string;
let store: ChangesStore;
let undoer: ChangeUndo;
const config = structuredClone(DEFAULTS) as AppConfig;

const entry = (over: Partial<ChangeEntry>): ChangeEntry => ({
  v: 1, id: `ch_${Math.random().toString(36).slice(2)}`, ts: new Date().toISOString(),
  turn: 1, tool: "write_file", callId: "c", op: "write", path: "a.txt",
  pathAbs: join(root, "a.txt"), before: null, after: null, bytes: 3, ...over,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mma-undo-"));
  store = new ChangesStore({
    sessionManager: { getSessionDirectory: () => join(root, "sessions", "s1") },
    getConfig: () => config,
  });
  undoer = new ChangeUndo({ store, getConfig: () => config, baseDir: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ChangeUndo", () => {
  it("restores content from before a write and steps further with steps=2", () => {
    const old1 = store.putBlob("s1", Buffer.from("v1"));
    const old2 = store.putBlob("s1", Buffer.from("v2"));
    writeFileSync(join(root, "a.txt"), "v3");
    const after2 = store.putBlob("s1", Buffer.from("v3"));
    store.append("s1", entry({ id: "e1", before: old1, after: old2 }));
    store.append("s1", entry({ id: "e2", before: old2, after: after2 }));

    expect(undoer.undo({ sessionId: "s1", baseDir: root, path: "a.txt" }).ok).toBe(true);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v2");
    expect(undoer.undo({ sessionId: "s1", baseDir: root, path: "a.txt" }).ok).toBe(true);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v1");
    expect(undoer.undo({ sessionId: "s1", baseDir: root, path: "a.txt" }).ok).toBe(false);
  });

  it("deletes a created file, recreates a deleted one, and refuses on conflict", () => {
    const content = store.putBlob("s1", Buffer.from("payload"));
    store.append("s1", entry({ id: "c", op: "write", before: null, after: content, pathAbs: join(root, "new.txt"), path: "new.txt" }));
    store.append("s1", entry({ id: "d", op: "delete", before: content, after: null, pathAbs: join(root, "gone.txt"), path: "gone.txt" }));

    expect(undoer.undo({ sessionId: "s1", baseDir: root, path: "new.txt" }).ok).toBe(true);
    expect(existsSync(join(root, "new.txt"))).toBe(false);
    expect(undoer.undo({ sessionId: "s1", baseDir: root, path: "gone.txt" }).ok).toBe(true);
    expect(readFileSync(join(root, "gone.txt"), "utf8")).toBe("payload");

    writeFileSync(join(root, "new.txt"), "changed-by-hand");
    const conflict = undoer.undo({ sessionId: "s1", baseDir: root, path: "new.txt" });
    expect(conflict.ok).toBe(false);
    expect(undoer.undo({ sessionId: "s1", baseDir: root, path: "new.txt", force: true }).ok).toBe(true);
  });

  it("undoes a whole turn and reports skipped conflicts", () => {
    const before = store.putBlob("s1", Buffer.from("before"));
    const after = store.putBlob("s1", Buffer.from("after"));
    writeFileSync(join(root, "a.txt"), "after");
    store.append("s1", entry({ id: "t1", turn: 7, before, after }));
    const res = undoer.undo({ sessionId: "s1", baseDir: root, turn: 7 });
    expect(res.ok).toBe(true);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("before");
  });

  it("reports evicted snapshots as unavailable", () => {
    const before = store.putBlob("s1", Buffer.from("old"));
    store.append("s1", entry({ id: "x", before, after: null }));
    store.append("s1", entry({ id: "ev", op: "evicted", targetId: "x", path: "a.txt", pathAbs: join(root, "a.txt"), before: null, after: null }));
    const res = undoer.undo({ sessionId: "s1", baseDir: root, path: "a.txt" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("evicted");
  });
});
```

- [ ] **Step 2: Run it; FAIL because `evict`/`ChangeUndo` don't exist**

`bun test tests/changes/undo.test.ts`

- [ ] **Step 3: Add `evict()` to the store**

Append inside `ChangesStore`:

```ts
  evict(sessionId: string): void {
    const cfg = this.deps.getConfig().changes ?? {};
    const maxBytes = cfg.maxTotalBytes ?? 67_108_864;
    const maxRevisions = cfg.maxRevisionsPerFile ?? 20;
    const entries = this.readEntries(sessionId);
    const invalid = new Set(entries.filter((e) => e.op === "undo" || e.op === "evicted").map((e) => e.targetId));
    const live = entries.filter((e) => !invalid.has(e.id) && !e.skipped);
    const used = new Set<string>();
    for (const e of live) for (const sha of [e.before, e.after, e.toBefore]) if (sha) used.add(sha);

    const byPath = new Map<string, ChangeEntry[]>();
    for (const e of live) byPath.set(e.pathAbs, [...(byPath.get(e.pathAbs) ?? []), e]);

    let total = 0;
    for (const sha of used) {
      const file = this.blob(sessionId, sha);
      if (existsSync(file)) total += statSync(file).size;
    }
    const victims: ChangeEntry[] = [];
    for (const list of byPath.values()) {
      if (list.length > maxRevisions) victims.push(...list.slice(0, list.length - maxRevisions));
    }
    for (const e of live) {
      if (total <= maxBytes) break;
      if (victims.includes(e)) continue;
      victims.push(e);
      total -= [e.before, e.after, e.toBefore].reduce((n, sha) => {
        if (!sha || !used.has(sha)) return n;
        used.delete(sha);
        const file = this.blob(sessionId, sha);
        const size = existsSync(file) ? statSync(file).size : 0;
        return n + size;
      }, 0);
    }
    for (const e of victims) {
      this.append(sessionId, { ...e, id: `ch_ev_${Date.now()}_${e.id}`, op: "evicted", targetId: e.id, skipped: "evicted" });
      for (const sha of [e.before, e.after, e.toBefore]) {
        if (!sha || used.has(sha)) continue;
        const file = this.blob(sessionId, sha);
        if (existsSync(file)) rmSync(file);
      }
    }
  }
```

Add `rmSync` to the `node:fs` import. `evict()` may append markers on every capture after the limit is reached; that is bounded by the number of live entries.

- [ ] **Step 4: Implement undo**

`src/modules/changes/undo.ts`:

```ts
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppConfig } from "../../config/types";
import { generateDiff } from "../../ui/diff";
import type { ChangesStore } from "./store";
import type { ChangeEntry, ListOptions, UndoOptions, UndoResult } from "./types";

export interface UndoDeps {
  store: ChangesStore;
  getConfig: () => AppConfig;
  baseDir: string;
  log?: (detail: Record<string, unknown>) => void;
}

interface Resolved extends ChangeEntry { target: ChangeEntry }

export class ChangeUndo {
  constructor(private readonly deps: UndoDeps) {}

  setBaseDir(dir: string): void {
    this.deps.baseDir = dir;
  }

  list(options: ListOptions): ChangeEntry[] {
    const items = this.effective(this.deps.store.readEntries(options.sessionId));
    const filtered = options.path
      ? items.filter((e) => e.path === options.path || e.pathAbs === resolve(this.deps.baseDir, options.path))
      : items;
    return filtered.slice(0, Math.min(options.limit ?? 10, 50)).reverse();
  }

  undo(options: UndoOptions): UndoResult {
    const entries = this.effective(this.deps.store.readEntries(options.sessionId));
    if (options.path) {
      const abs = resolve(this.deps.baseDir, options.path);
      const mine = entries.filter((e) => e.pathAbs === abs).reverse();
      const steps = options.steps ?? 1;
      if (mine.length < steps) return { ok: false, message: "not enough undo steps for this file", items: [] };
      return this.apply([mine[steps - 1]!], options.force === true, options.sessionId);
    }
    const turn = options.turn ?? this.deps.store.loadTurn(options.sessionId);
    const mine = entries.filter((e) => e.turn === turn).reverse();
    if (mine.length === 0) return { ok: false, message: `no changes recorded in turn ${turn}`, items: [] };
    return this.apply(mine, options.force === true, options.sessionId);
  }

  private effective(all: ChangeEntry[]): ChangeEntry[] {
    const dead = new Set(all.filter((e) => e.op === "undo" || e.op === "evicted").map((e) => e.targetId));
    return all.filter((e) => (e.op === "write" || e.op === "delete" || e.op === "move") && !dead.has(e.id) && !e.skipped);
  }

  private apply(targets: ChangeEntry[], force: boolean, sessionId: string): UndoResult {
    const items: Array<{ path: string; ok: boolean; reason?: string }> = [];
    const diffs: string[] = [];
    for (const e of targets) {
      try {
        const reason = this.conflict(e);
        if (reason && !force) { items.push({ path: e.path, ok: false, reason }); continue; }
        const current = this.readText(e.pathAbs);
        this.restore(e, sessionId);
        items.push({ path: e.path, ok: true });
        const restored = this.readText(e.pathAbs);
        if (current !== null && restored !== null) diffs.push(generateDiff(current, restored));
        const marker: ChangeEntry = {
          ...e, id: `ch_undo_${Date.now()}_${e.id}`, op: "undo", targetId: e.id,
          ts: new Date().toISOString(), turn: this.deps.store.loadTurn(sessionId) || 1,
        };
        this.deps.store.append(sessionId, marker);
        this.deps.log?.({ path: e.path, op: e.op, targetId: e.id, tool: e.tool });
      } catch (err) {
        items.push({ path: e.path, ok: false, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    const ok = items.some((i) => i.ok);
    return {
      ok,
      items,
      message: items.map((i) => `${i.path}: ${i.ok ? "restored" : `skipped (${i.reason})`}`).join("; "),
      diff: diffs.join("\n") || undefined,
    };
  }

  private conflict(e: ChangeEntry): string | null {
    const current = this.sha(e.pathAbs);
    if (current !== e.after) return "file changed since the snapshot";
    if (e.op === "move" && e.to) {
      const dest = resolve(this.deps.baseDir, e.to);
      if (this.sha(dest) !== (e.toBefore ?? null)) return "move destination changed since the snapshot";
    }
    return null;
  }

  private restore(e: ChangeEntry, sessionId: string): void {
    if (e.op === "move" && e.to) {
      const dest = resolve(this.deps.baseDir, e.to);
      if (!existsSync(dest)) throw new Error(`move destination missing: ${dest}`);
      const body = this.deps.store.getBlob(sessionId, e.before);
      if (body) this.write(e.pathAbs, body, e.mode);
      else rmSync(e.pathAbs, { force: true });
      if (e.toBefore) this.write(dest, this.deps.store.getBlob(sessionId, e.toBefore)!, undefined);
      else rmSync(dest, { force: true });
      return;
    }
    const body = this.deps.store.getBlob(sessionId, e.before);
    if (body) this.write(e.pathAbs, body, e.mode);
    else rmSync(e.pathAbs, { force: true });
  }

  private write(path: string, body: Buffer, mode?: number): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    if (mode !== undefined) chmodSync(path, mode);
  }

  private sha(path: string): string | null {
    if (!existsSync(path)) return null;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  private readText(path: string): string | null {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  }
}
```

Add `chmodSync` to imports and `createHash` from `node:crypto`; replace the unused `void moved` line with simply checking destination existence before reading. Keep `list()` output bounded (max 50).

- [ ] **Step 5: Run tests and commit**

`bun test tests/changes/store.test.ts tests/changes/undo.test.ts tests/changes/capture.test.ts` → PASS.
`git add src/modules/changes && git commit -m "feat(changes): eviction and undo semantics"`

---

### Task 5: Port type, executor seam, turn boundary, both context builders

**Files:**
- Modify: `src/tools/types.ts`, `src/tools/executor.ts`, `src/core/agent/turn-run.ts`, `src/core/bootstrap/tool-context.ts`, `src/core/bootstrap/session-runner-scope.ts`, `src/core/bootstrap/session-phase.ts`, `src/core/bootstrap/session-runner.ts`
- Create: `src/modules/changes/index.ts`
- Test: `tests/changes/port.test.ts`

Before editing `src/tools/executor.ts` and `src/core/agent/turn-run.ts`, read §1 of `docs/specs/2026-10-12-architecture-v2-design.md` (per AGENTS.md).

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/changes/port.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import { createFileChangesPort } from "../../src/modules/changes";
import { ToolExecutor } from "../../src/tools/executor";
import { ToolRegistry } from "../../src/tools/registry";
import type { ToolContext, ToolDefinition } from "../../src/tools/types";

describe("FileChangesPort", () => {
  it("records a successful write executed through ToolExecutor and restores it", () => {
    const root = mkdtempSync(join(tmpdir(), "mma-port-"));
    try {
      const config = structuredClone(DEFAULTS) as AppConfig;
      const sessionManager = { getSessionDirectory: (id: string) => join(root, "sessions", id) };
      mkdirSync(join(root, "sessions", "s1"), { recursive: true });
      const port = createFileChangesPort({ sessionManager, getConfig: () => config });
      port.beginTurn("s1");
      const file = join(root, "a.txt");
      writeFileSync(file, "before");
      const tool: ToolDefinition = {
        name: "write_file", description: "", parameters: {}, security: { caps: [{ fs: "write" }] },
        handler: async () => { writeFileSync(file, "after"); return { success: true, output: "ok" }; },
      };
      const registry = new ToolRegistry();
      registry.register(tool);
      const ctx = {
        config, baseDir: root, logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
        sessionId: "s1", exitOnComplete: true, contextManager: {} as never, activeToolTags: [],
        fileChanges: port,
      } as unknown as ToolContext;
      const result = await new ToolExecutor(registry, ctx, { getAllPlugins: () => [] } as never)
        .execute({ id: "call1", name: "write_file", arguments: { path: "a.txt" } });
      expect(result.success).toBe(true);
      expect(port.undo({ sessionId: "s1", baseDir: root, path: "a.txt" }).ok).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("before");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```

(Add `mkdirSync`/`readFileSync` to the test imports.)

- [ ] **Step 2: Run it; FAIL — `ctx.fileChanges` is never called**

`bun test tests/changes/port.test.ts`

- [ ] **Step 3: Create the port factory**

`src/modules/changes/index.ts`:

```ts
import type { AppConfig } from "../../config/types";
import type { Diagnostic } from "../../output/types";
import type { FileChangesPort, ToolCall, ToolContext, ToolDefinition } from "../../tools/types";
import { ChangeCapture } from "./capture";
import { ChangesStore } from "./store";
import { ChangeUndo } from "./undo";

export interface PortDeps {
  sessionManager: { getSessionDirectory(id: string): string };
  getConfig: () => AppConfig;
  log?: (detail: Record<string, unknown>) => void;
  onDiagnostic?: (d: Diagnostic) => void;
}

export function createFileChangesPort(deps: PortDeps): FileChangesPort {
  const store = new ChangesStore({ sessionManager: deps.sessionManager, getConfig: deps.getConfig });
  const capture = new ChangeCapture(store, deps.getConfig, deps.onDiagnostic);
  const undoer = new ChangeUndo({
    store, getConfig: deps.getConfig, baseDir: "", log: deps.log,
  });
  return {
    beginTurn: (sessionId) => { store.nextTurn(sessionId); },
    captureBefore: (ctx, tool, call) => capture.before(ctx, tool, call),
    captureAfter: (callId, success) => capture.after(callId, success),
    list: (options) => {
      undoer.setBaseDir(options.baseDir);
      return undoer.list(options);
    },
    undo: (options) => {
      undoer.setBaseDir(options.baseDir);
      return undoer.undo(options);
    },
  };
}
```

`baseDir` is required in `ListOptions`/`UndoOptions` (Task 2), so every caller passes it explicitly; `setBaseDir` keeps one `ChangeUndo` instance per port.

- [ ] **Step 4: Define the port in `src/tools/types.ts`**

```ts
import type { ListOptions, UndoOptions, UndoResult } from "../modules/changes/types";
import type { ChangeEntry } from "../modules/changes/types";

export interface FileChangesPort {
  beginTurn(sessionId: string): void;
  captureBefore(ctx: ToolContext, tool: ToolDefinition, call: ToolCall): void;
  captureAfter(callId: string, success: boolean): void;
  list(options: ListOptions): ChangeEntry[];
  undo(options: UndoOptions): UndoResult;
}
```

Add to `ToolContext`:

```ts
  /** Снапшоты правок файлов; ставят оба билдера контекста. */
  fileChanges?: FileChangesPort;
```

- [ ] **Step 5: Wire the executor seam**

In `src/tools/executor.ts:execute()`, after `this.ctx.pathGuard = createPathGuard(...)`:

```ts
    this.ctx.fileChanges?.captureBefore(this.ctx, tool, call);
```

After `result = finalizeToolResult(this.ctx, tool, call, result);`:

```ts
    this.ctx.fileChanges?.captureAfter(call.id, result.success);
```

- [ ] **Step 6: Wire turn boundary**

In `src/core/agent/turn-run.ts`, right after `const activeMeta = sessionManager?.getActiveMeta();` (~line 111):

```ts
  if (activeMeta) deps.toolCtx?.fileChanges?.beginTurn(activeMeta.id);
```

- [ ] **Step 7: Wire both context builders**

In `src/core/bootstrap/tool-context.ts`: add `fileChanges?: FileChangesPort` to `ToolContextInput`, import `createFileChangesPort`, and after the `sessionManager` getter:

```ts
  Object.defineProperty(toolCtx, "fileChanges", {
    get: () => input.fileChanges ?? createFileChangesPort({
      sessionManager,
      getConfig: () => configRef.current,
      log: (detail) => sessionManager.appendLog({
        ts: new Date().toISOString(), type: "change", source: "module:changes",
        module: "changes", operation: "changes.undo", ...detail,
      } as never),
    }),
    configurable: true,
  });
```

Do the equivalent in `src/core/bootstrap/session-runner-scope.ts` (`RunnerToolCtxInput` + getter). In `src/core/bootstrap/session-phase.ts` and `src/core/bootstrap/session-runner.ts` no extra changes are needed: both builders already receive `sessionManager`/`configRef`; the getter creates the port lazily. (If a builder passes `fileChanges` explicitly later, the getter prefers it.)

- [ ] **Step 8: Run tests, typecheck, arch gates, commit**

`bun test tests/changes/port.test.ts tests/arch/module-boundaries.test.ts tests/arch/file-size.test.ts` → PASS.
`bun run typecheck && bun run check:arch`
`git add src/modules/changes/index.ts src/tools src/core && git commit -m "feat(changes): wire port into executor and turn boundary"`

---

### Task 6: Tools `list_file_changes` and `restore_file`

**Files:**
- Create: `src/tools/restore-file.ts`, `src/tools/list-file-changes.ts`
- Modify: `src/tools/index.ts`, `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/changes/tools.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/changes/tools.test.ts
import { describe, expect, it } from "bun:test";
import { restoreFileTool, listFileChangesTool } from "../../src/tools/index";

describe("changes tools", () => {
  it("declares write capability and a path argument for restore", () => {
    expect(restoreFileTool.security).toEqual({ caps: [{ fs: "write" }], pathArgs: ["path"] });
    expect(restoreFileTool.alwaysOn).toBe(true);
    expect(listFileChangesTool.security.caps).toEqual([{ fs: "read" }]);
  });

  it("returns a readable message when no session is attached", async () => {
    const ctx = {
      sessionId: undefined, baseDir: process.cwd(), config: {}, logger: {} as never,
    } as never;
    const res = await restoreFileTool.handler(ctx, { path: "a.txt" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("session");
  });
});
```

- [ ] **Step 2: Run it; FAIL — no exports**

`bun test tests/changes/tools.test.ts`

- [ ] **Step 3: Implement the tools**

`src/tools/list-file-changes.ts`:

```ts
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";

export const listFileChangesTool: ToolDefinition = {
  name: "list_file_changes",
  description: "List undoable file-tool changes in this session (newest first). Does not cover bash edits.",
  security: { caps: [{ fs: "read" }] },
  icon: "🕘",
  tags: ["file"],
  alwaysOn: true,
  boundedOutput: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Optional file path to filter by" },
      limit: { type: "integer", description: "Max entries, 1-50 (default 10)" },
    },
  },
  handler: async (ctx, args) => {
    if (!ctx.sessionId || !ctx.fileChanges) return { success: false, output: t("changes.no_session") };
    const entries = ctx.fileChanges.list({
      sessionId: ctx.sessionId,
      baseDir: ctx.baseDir,
      path: args.path ? String(args.path) : undefined,
      limit: args.limit ? Number(args.limit) : 10,
    });
    if (entries.length === 0) return { success: true, output: t("changes.empty") };
    return {
      success: true,
      output: entries.map((e) =>
        `${e.id} · turn ${e.turn} · ${e.tool} · ${e.op} · ${e.path}${e.skipped ? ` [${e.skipped}]` : ""}`,
      ).join("\n"),
    };
  },
};
```

`src/tools/restore-file.ts`:

```ts
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";

export const restoreFileTool: ToolDefinition = {
  name: "restore_file",
  description:
    "Undo a file-tool edit in this session: one step by default, or every edit of a turn. " +
    "Coverage: file tools only — bash edits are not tracked. " +
    "Refuses when the file changed since the snapshot; read the file first or pass force.",
  security: { caps: [{ fs: "write" }], pathArgs: ["path"] },
  icon: "↩️",
  tags: ["file"],
  alwaysOn: true,
  boundedOutput: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (omit when undoing a whole turn)" },
      steps: { type: "integer", description: "How many undo steps (default 1)" },
      turn: { type: "integer", description: "Undo all changes of this turn instead of a path" },
      force: { type: "boolean", description: "Ignore hash conflicts; never bypasses path policy" },
    },
  },
  handler: async (ctx, args) => {
    if (!ctx.sessionId || !ctx.fileChanges) return { success: false, output: t("changes.no_session") };
    const result = ctx.fileChanges.undo({
      sessionId: ctx.sessionId,
      baseDir: ctx.baseDir,
      path: args.path ? String(args.path) : undefined,
      steps: args.steps ? Number(args.steps) : 1,
      turn: args.turn ? Number(args.turn) : undefined,
      force: args.force === true,
    });
    return { success: result.ok, output: result.message, ...(result.diff ? { diff: result.diff } : {}) };
  },
};
```

Export both from `src/tools/index.ts` (import next to file tools; add to `tools` array next to `deleteFileTool`).

Insert symmetric keys in both `src/i18n/en.json`/`ru.json`:

```json
  "changes.no_session": "No active session with change history — nothing to restore.",
  "changes.empty": "No recorded file changes to undo.",
```

- [ ] **Step 4: Run tests, security-declaration gate, commit**

`bun test tests/changes/tools.test.ts tests/tools/security-decl.test.ts tests/arch/tool-registration.test.ts` → PASS.
`git add src/tools src/i18n tests/changes/tools.test.ts && git commit -m "feat(changes): restore and list tools"`

---

### Task 7: CLI `mma undo`

**Files:**
- Create: `src/cli/undo-command.ts`
- Modify: `src/cli/commands.ts`, `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/cli/undo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/undo.test.ts
import { describe, expect, it } from "bun:test";
import { createProgram } from "../../src/cli/commands";

describe("mma undo", () => {
  it("is registered with path/list/turn options", () => {
    const cmd = createProgram().commands.find((c) => c.name() === "undo");
    expect(cmd).toBeDefined();
    const flags = cmd!.options.map((o) => o.long);
    expect(flags).toContain("--steps");
    expect(flags).toContain("--force");
    expect(flags).toContain("--turn");
    expect(flags).toContain("--list");
  });
});
```

- [ ] **Step 2: Run; FAIL — command absent**

`bun test tests/cli/undo.test.ts`

- [ ] **Step 3: Implement the command**

`src/cli/undo-command.ts`:

```ts
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { bootstrap } from "../core/bootstrap";
import { createFileChangesPort } from "../modules/changes";
import { matchProtectedPath } from "../modules/security/protected-paths";
import { getDefaultChannel } from "../output";
import { t } from "../i18n/index";
import { fail } from "./exit-code";

export async function runUndo(
  args: string[],
  write: (line: string, stream?: "stderr") => void,
): Promise<void> {
  const [path, flag] = args;
  const opts = parseUndoArgs(args);
  const boot = await bootstrap();
  const sessionId = opts.session ?? boot.sessionManager.getActive();
  if (!sessionId) { write(t("changes.no_session"), "stderr"); return; }
  if (path && matchProtectedPath(boot.baseDir, path)) {
    write(t("file.protected_path_ask", { path, pattern: matchProtectedPath(boot.baseDir, path) }), "stderr");
    return;
  }
  if (path && lstatSync(resolve(boot.baseDir, path), { throwIfNoEntry: false })?.isSymbolicLink()) {
    write(t("changes.symlink_refused", { path }), "stderr");
    return;
  }
  const port = createFileChangesPort({
    sessionManager: boot.sessionManager,
    getConfig: () => boot.config,
  });
  const baseDir = boot.baseDir;
  if (opts.list) {
    const entries = port.list({ sessionId, baseDir, path, limit: 50 });
    for (const e of entries) write(`${e.id} · ${e.op} · ${e.path} · turn ${e.turn}`);
    return;
  }
  if (!path && opts.turn === undefined) { write(t("cli.undo_usage_hint"), "stderr"); return; }
  const result = port.undo({
    sessionId, baseDir, path,
    steps: Number(opts.steps) || 1,
    force: opts.force,
    turn: typeof opts.turn === "string" ? Number(opts.turn) : undefined,
  });
  write(result.message, result.ok ? undefined : "stderr");
}

function parseUndoArgs(args: string[]): {
  path?: string; steps: string; force: boolean; turn?: string | boolean; list: boolean; session?: string;
} {
  const out: { path?: string; steps: string; force: boolean; turn?: string | boolean; list: boolean; session?: string } =
    { steps: "1", force: false, list: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--force") out.force = true;
    else if (a === "--list") out.list = true;
    else if (a === "--turn") out.turn = args[i + 1] && !args[i + 1]!.startsWith("--") ? args[++i]! : true;
    else if (a === "--steps") out.steps = args[++i] ?? "1";
    else if (a === "--session") out.session = args[++i];
    else if (!a.startsWith("--")) { out.path ??= a; }
  }
  return out;
}

export function buildUndoCommand(program: Command): void {
  program
    .command("undo")
    .description(t("cli.undo"))
    .argument("[path]", t("cli.undo_path"))
    .option("--steps <n>", t("cli.undo_steps"), "1")
    .option("--force", t("cli.undo_force"))
    .option("--turn [n]", t("cli.undo_turn"))
    .option("--list", t("cli.undo_list"))
    .option("--session <id>", t("cli.undo_session"))
    .action(async (path: string | undefined, opts: {
      steps: string; force?: boolean; turn?: string | boolean; list?: boolean; session?: string;
    }) => {
      const args: string[] = path ? [path] : [];
      if (opts.force) args.push("--force");
      if (opts.list) args.push("--list");
      if (opts.session) args.push("--session", opts.session);
      if (opts.steps !== "1") args.push("--steps", opts.steps);
      if (opts.turn !== undefined) {
        args.push("--turn");
        if (typeof opts.turn === "string") args.push(opts.turn);
      }
      await runUndo(args, (line, stream) => {
        if (stream === "stderr") fail(line);
        else getDefaultChannel().writeLine(line);
      });
    });
}
```

Register in `src/cli/commands.ts`: import `buildUndoCommand` and call `buildUndoCommand(program);` after `buildSessionCommands(program);`.

Add symmetric keys to both locale files: `cli.undo`, `cli.undo_path`, `cli.undo_steps`, `cli.undo_force`, `cli.undo_turn`, `cli.undo_list`, `cli.undo_session`, `cli.undo_usage_hint`, `changes.symlink_refused`.

- [ ] **Step 4: Run tests and live smoke check**

`bun test tests/cli/undo.test.ts tests/cli/commands.test.ts tests/i18n.test.ts` → PASS.
Live: `MMA_CONFIG_DIR=<temp> bun run mma undo --help` → shows the command and options (no writes).
`git add src/cli src/i18n tests/cli/undo.test.ts && git commit -m "feat(changes): mma undo command"`

---

### Task 8: Slash command `/undo`

**Files:**
- Modify: `src/core/commands/spec.ts`, `src/cli/repl-commands-session.ts`, `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/changes/slash.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/changes/slash.test.ts
import { describe, expect, it } from "bun:test";
import { CATALOG } from "../../src/core/commands/catalog";

describe("/undo", () => {
  it("exists in the command catalog and is terminal-only", () => {
    const cmd = CATALOG.find((c) => c.name === "undo");
    expect(cmd).toBeDefined();
    expect(cmd!.surfaces).toBeUndefined();
    expect(cmd!.group).toBe("session");
  });
});
```

- [ ] **Step 2: Run; FAIL — catalog entry absent**

`bun test tests/changes/slash.test.ts`

- [ ] **Step 3: Add catalog spec and handler**

In `src/core/commands/spec.ts`, add to `SPEC_DEFS`:

```ts
  {
    name: "undo",
    descriptionKey: "repl.undo",
    usageKey: "repl.undo_usage",
    group: "session",
    examples: ["/undo", "/undo src/a.ts", "/undo --turn", "/undo --list"],
  },
```

In `src/cli/repl-commands-session.ts`, inside its `register…Commands(ctx)` function add (exactly 4-space `name:` indentation — the catalog gate scans for it):

```ts
    ctx.registerCommand({
      name: "undo",
      description: t("repl.undo"),
      usage: t("repl.undo_usage"),
      action: async (args) => {
        await runUndo(args, (line, stream) => ctx.output.writeLine(line, stream));
      },
    });
```

Import 'runUndo' from '../cli/undo-command' at the top of repl-commands-session.ts; the helper resolves session/baseDir through bootstrap().

Add symmetric keys `repl.undo`, `repl.undo_usage` to both locale files.

- [ ] **Step 4: Run command gates and commit**

`bun test tests/changes/slash.test.ts tests/core/command-catalog.test.ts tests/core/command-catalog-i18n.test.ts tests/cli/repl-help.test.ts tests/service/host-command-catalog.test.ts` → PASS.
`git add src/core/commands src/cli/repl-commands-session.ts src/i18n tests/changes/slash.test.ts && git commit -m "feat(changes): /undo slash command"`

---

### Task 9: Observability, docs and final gates

**Files:**
- Modify: `docs/agents/architecture.md`, `docs/agents/gates.md`
- Verify: session log `change` events from Task 5; all gates

- [ ] **Step 1: Verify the event contract with a test**

```ts
// tests/changes/session-log.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import { createFileChangesPort } from "../../src/modules/changes";
import { ChangesStore } from "../../src/modules/changes/store";

describe("change log events", () => {
  it("emits type:change with module:changes on undo", () => {
    const root = mkdtempSync(join(tmpdir(), "mma-log-"));
    try {
      const events: Array<Record<string, unknown>> = [];
      const config = structuredClone(DEFAULTS) as AppConfig;
      const sessionManager = { getSessionDirectory: (id: string) => join(root, "sessions", id) };
      const store = new ChangesStore({ sessionManager, getConfig: () => config });
      const before = store.putBlob("s1", Buffer.from("old"));
      mkdirSync(join(root, "sessions", "s1"), { recursive: true });
      writeFileSync(join(root, "a.txt"), "new");
      store.append("s1", {
        v: 1, id: "e1", ts: new Date().toISOString(), turn: 1, tool: "write_file",
        callId: "c1", op: "write", path: "a.txt", pathAbs: join(root, "a.txt"),
        before, after: store.putBlob("s1", Buffer.from("new")), bytes: 3,
      });
      const port = createFileChangesPort({
        sessionManager, getConfig: () => config,
        log: (detail) => events.push({ type: "change", source: "module:changes", module: "changes", operation: "changes.undo", ...detail }),
      });
      expect(port.undo({ sessionId: "s1", baseDir: root, path: "a.txt" }).ok).toBe(true);
      expect(events[0]).toMatchObject({ type: "change", source: "module:changes", path: "a.txt" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```


- [ ] **Step 2: Update docs**

In `docs/agents/architecture.md`, add a short paragraph: file-rollback port in `ToolContext`, capture in `ToolExecutor`, module `src/modules/changes`, undo tools/CLI. In `docs/agents/gates.md`, add the row `инвариант «каждый fs-write тул покрыт снапшотом» → tests/arch/changes-coverage.test.ts`. Keep links relative and run `bun test tests/docs-link-check.test.ts`.

- [ ] **Step 3: Full verification**

`bun test` — whole suite; `bun run quality` — typecheck + frontend + arch gates + lint + fallow. Both must be green. Live agent run in isolated config: `MMA_CONFIG_DIR=<temp> bun run mma -d <sandbox> "create a file then restore it with restore_file"`; verify `session.jsonl` contains a `change` event and the file content is restored.

- [ ] **Step 4: Commit**

`git add docs tests/changes/session-log.test.ts && git commit -m "docs: document file rollback and coverage gate"`

---

## Self-review notes (resolved during planning)

- `move_file` arguments are `from`/`to`, not `path`/`newPath` — captured in Task 3 table and Task 4 undo.
- Config domain count gate (18→19), i18n labels, and exactly-one web panel placement are in Task 1.
- Two `ToolContext` builders exist — Task 5 covers both; forks inherit the getter.
- Slash command should call the shared `runUndo` helper extracted in Task 7, not reach into `ReplContext` internals.
- CHANGELOG is untouched (requires explicit user command); version bump happens at release as MINOR.
