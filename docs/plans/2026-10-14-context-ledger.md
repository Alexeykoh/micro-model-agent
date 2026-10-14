# Context Ledger (OO-3/6/8) + Oversight — Wave W-c Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заметки/адреса (`path:line`, `url`) переживают **любое** число компакций и не вытесняются, помечаются stale при изменении файла, а серия компакций без прогресса даёт различимый сигнал — чтобы 9B не галлюцинировала найденное под давлением (воспроизведено: `docs/analysis`-прогон `hard-multi-extreme`, 11 компакций → выдуманные `NEEDLE_B/C`).

**Motivation (evidence):** под порогом 0.15 агент 11 раз сжал контекст, потерял найденные значения и выдал `NEEDLE_B_54`/`NEEDLE_C_18` вместо `NEEDLE_B_222`/`NEEDLE_C_333`; сессия ушла в цикл (56 итераций, `exit=1`). Текущий `toolLedger` (`manager.ts:733`) хранит `tool(args) → первая строка` (120 симв., cap `TOOL_LEDGER_MAX_ENTRIES = 12`), поэтому находки из середины вывода `grep` не сохранялись.

**Architecture:** Durable файл-леджер на диске (append-only, дедуп, cap со свёрткой), владелец — `ContextManager` (он же строит блок компакции). Блок компакции несёт только указатель `[Notes: <path>, N]`; сам файл компакция не трогает. Адреса пишет харнесс из метаданных тул-результатов (OO-6). Изменение файла тулом write/edit помечает адреса stale (OO-8). Серия компакций без прироста леджера → diagnostic.

**Tech Stack:** Bun + TS (strict), vitest, Biome; паттерн диагностик INV-15 (`docs/agents/observability.md`, `admissionDiagnosticSink`).

**Base:** ветка `feat/context-ledger` от `docs/architecture-v2` (W-a/W-b уже в базе).

**Гейт:** `bun test` зелёный, `bun run quality` exit 0. Потолки `.arch-allowlist.json` не поднимать (следить за размером `manager.ts`).

---

## File Structure

| Файл | Ответственность | Действие |
|---|---|---|
| `src/config/types-budget.ts` | поле `notesPath`, `ledgerMax` в `ContextBudget` | Modify |
| `src/config/defaults.ts` | дефолты `contextBudget.notesPath`, `ledgerMax` | Modify |
| `src/config/registry-extra.ts` | ключи реестра | Modify |
| `src/core/context/ledger.ts` | `ContextLedger`: файл-леджер адресов (dedupe/cap/свёртка/stale) | Create |
| `src/core/context/ledger-parse.ts` | `addressesFromToolResult(name, args, content)` → адреса | Create |
| `src/core/context/manager.ts` | подключение леджера: запись при компакции, указатель в блоке, stale на запись, детектор прогресса | Modify |
| `src/modules/webui/.../controls.ts`, `tests/config/registry.test.ts`, `tests/cli/completer-config.test.ts` | новые ключи в перечислениях/панели | Modify |
| `tests/core/ledger.test.ts` | юнит-тесты леджера | Create |
| `tests/core/ledger-manager.test.ts` | интеграция с ContextManager | Create |

---

## Task 1: Config keys `context.notesPath` + `context.ledgerMax`

**Files:**
- Modify: `src/config/types-budget.ts`, `src/config/defaults.ts`, `src/config/registry-extra.ts`
- Modify: `src/modules/webui/assets/js/settings/controls.ts`, `tests/config/registry.test.ts`, `tests/cli/completer-config.test.ts`
- Test: `tests/config/ledger-keys.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/config/ledger-keys.test.ts
import { describe, it, expect } from "vitest";
import { DEFAULTS } from "../src/config/defaults";
import { getConfigValue, setConfigValue } from "../src/config/registry";
import type { AppConfig } from "../src/config/types";

describe("context ledger config", () => {
  it("has defaults", () => {
    expect(DEFAULTS.contextBudget.notesPath).toBe("NOTES.md");
    expect(DEFAULTS.contextBudget.ledgerMax).toBe(200);
  });
  it("round-trips through the registry", () => {
    const c = structuredClone(DEFAULTS) as AppConfig;
    expect(getConfigValue(c, "contextBudget.notesPath").value).toBe("NOTES.md");
    expect(setConfigValue(c, "contextBudget.notesPath", "docs/notes.md").ok).toBe(true);
    expect(getConfigValue(c, "contextBudget.notesPath").value).toBe("docs/notes.md");
    expect(setConfigValue(c, "contextBudget.ledgerMax", "50").ok).toBe(true);
    expect(setConfigValue(c, "contextBudget.ledgerMax", "0").ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**
Run: `bun test tests/config/ledger-keys.test.ts` → FAIL.
Expected: undefined defaults / unresolved keys.

- [ ] **Step 3: Add fields to `ContextBudget`** (in `src/config/types-budget.ts`, after `admitMaxTokens`)

```ts
  /**
   * OO-3: путь к файлу-леджеру адресов (относительно корня проекта). Файл
   * переживает любую компакцию; блок компакции несёт только указатель.
   */
  notesPath?: string;
  /** Потолок числа адресных записей леджера до свёртки старейших в индекс по файлам. */
  ledgerMax?: number;
```

- [ ] **Step 4: Defaults** (in `src/config/defaults.ts`, inside `contextBudget`, after `admitMaxTokens`)

```ts
    notesPath: "NOTES.md",
    ledgerMax: 200,
```

- [ ] **Step 5: Registry keys** (in `src/config/registry-extra.ts`, next to the other `contextBudget.*` entries)

```ts
  str("contextBudget.notesPath", "budget",
    (c) => c.contextBudget.notesPath ?? DEFAULTS.contextBudget.notesPath,
    (c, v) => { c.contextBudget.notesPath = String(v); }),
  int("contextBudget.ledgerMax", "budget", 10, 5000, 10, true,
    (c) => c.contextBudget.ledgerMax ?? DEFAULTS.contextBudget.ledgerMax,
    (c, v) => { c.contextBudget.ledgerMax = v as number; }),
```

- [ ] **Step 6: Update enumerations** — add both keys to `tests/config/registry.test.ts` (group list), `tests/cli/completer-config.test.ts`, and place `contextBudget.notesPath`/`ledgerMax` in exactly one panel in `src/modules/webui/assets/js/settings/controls.ts` (same `context.compaction` panel), following the `admitMaxTokens` placement. Also add `config.key/desc.*` i18n labels to both locales (the `tests/i18n.test.ts` registry-key check requires them).

- [ ] **Step 7: Run tests + full suite**
Run: `bun test tests/config/ledger-keys.test.ts tests/i18n.test.ts tests/config/registry.test.ts tests/cli/completer-config.test.ts tests/webui-config-extra.test.ts` → PASS.

- [ ] **Step 8: Commit**
```bash
git add -A
git commit -m "feat(config): contextBudget.notesPath + ledgerMax (OO-3/OO-8)"
```

---

## Task 2: `ContextLedger` (file-backed address ledger)

**Files:**
- Create: `src/core/context/ledger.ts`
- Test: `tests/core/ledger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/ledger.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextLedger } from "../../src/core/context/ledger";

let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mma-led-")); path = join(dir, "NOTES.md"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("ContextLedger", () => {
  it("appends, dedupes and persists across reloads", () => {
    const l = new ContextLedger(path, 200);
    l.record("src/a.ts:10", "found NEEDLE_A_111");
    l.record("src/a.ts:10", "found NEEDLE_A_111"); // dup → ignored
    l.record("src/b.ts:5", "other");
    expect(l.size()).toBe(2);
    expect(existsSync(path)).toBe(true);
    const reloaded = new ContextLedger(path, 200);
    reloaded.load();
    expect(reloaded.size()).toBe(2);
    expect(reloaded.render()).toContain("src/a.ts:10");
    expect(readFileSync(path, "utf8")).toContain("src/a.ts:10");
  });

  it("marks a path stale on change and reports staleness", () => {
    const l = new ContextLedger(path, 200);
    l.record("src/a.ts:10", "fact");
    l.markStale("src/a.ts");
    expect(l.isStale("src/a.ts:10")).toBe(true);
    expect(l.render()).toContain("(stale)");
  });

  it("caps entries by folding the oldest into a per-file index", () => {
    const l = new ContextLedger(path, 3);
    for (let i = 0; i < 6; i++) l.record(`f${i}.ts:${i}`, `n${i}`);
    expect(l.size()).toBeLessThanOrEqual(4); // cap + index line
    expect(l.render()).toContain("index");
  });

  it("pointerLine reports the path and count", () => {
    const l = new ContextLedger(path, 200);
    l.record("x.ts:1", "n");
    expect(l.pointerLine()).toContain("x.ts") /* path form */;
    expect(l.pointerLine()).toMatch(/\b1\b/);
  });
});
```

- [ ] **Step 2: Run it → FAIL (module missing).**

- [ ] **Step 3: Implement `src/core/context/ledger.ts`**

```ts
// src/core/context/ledger.ts
// Durable леджер адресов (OO-3): `path:line — заметка`. Переживает любую
// компакцию; дедуп по адресу, cap со свёрткой старейших в индекс по файлам,
// пометка stale при изменении источника (OO-8).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, relative } from "node:path";

export interface LedgerEntry {
  /** Адрес: `path:line`, `path:§heading`, `url#section`. */
  address: string;
  note: string;
  stale: boolean;
}

const STALE_MARK = " (stale)";

/** Файл-леджер адресов с дедупом, cap-свёрткой и staleness. */
export class ContextLedger {
  private entries: LedgerEntry[] = [];
  private byAddress = new Map<string, LedgerEntry>();
  private indexPath: string | null = null;

  constructor(
    private readonly filePath: string,
    private readonly max: number,
  ) {}

  /** Загружает существующий файл (idempotent). Формат строки: `address — note`. */
  load(): void {
    if (!existsSync(this.filePath)) return;
    for (const raw of readFileSync(this.filePath, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("[index]")) {
        if (line.startsWith("[index]")) this.indexPath = line.slice("[index]".length).trim();
        continue;
      }
      const i = line.indexOf(" — ");
      if (i < 0) continue;
      const address = line.slice(0, i).trim();
      const note = line.slice(i + 3).replace(STALE_MARK, "").trim();
      const stale = line.includes(STALE_MARK);
      if (!this.byAddress.has(address)) {
        const e: LedgerEntry = { address, note, stale };
        this.entries.push(e);
        this.byAddress.set(address, e);
      }
    }
  }

  size(): number {
    return this.entries.length;
  }

  /** Добавляет адрес (дедуп по адресу; повтор обновляет заметку) и персистит. */
  record(address: string, note: string): void {
    const existing = this.byAddress.get(address);
    if (existing) {
      if (existing.note !== note) {
        existing.note = note;
        this.persistLine(address, note);
      }
      return;
    }
    const e: LedgerEntry = { address, note, stale: false };
    this.entries.push(e);
    this.byAddress.set(address, e);
    this.persistLine(address, note);
    this.enforceCap();
  }

  /** OO-8: пометить адреса файла stale. */
  markStale(pathPrefix: string): void {
    for (const e of this.entries) {
      if (e.address === pathPrefix || e.address.startsWith(`${pathPrefix}:`)) e.stale = true;
    }
  }

  isStale(address: string): boolean {
    return this.byAddress.get(address)?.stale ?? false;
  }

  /** Строка-указатель для блока компакции: `[Notes: <path>, N]`. */
  pointerLine(): string {
    return this.entries.length === 0 ? "" : `[Notes: ${this.shortPath()}, ${this.entries.length}]`;
  }

  /** Рендер леджера для модели (без сырья): адреса + заметки. */
  render(): string {
    const lines = this.entries.map(
      (e) => `${e.address} — ${e.note}${e.stale ? STALE_MARK : ""}`,
    );
    if (this.indexPath) lines.push(`[index] ${this.indexPath}`);
    return lines.join("\n");
  }

  private shortPath(): string {
    try {
      return relative(process.cwd(), this.filePath) || this.filePath;
    } catch {
      return this.filePath;
    }
  }

  private persistLine(address: string, note: string): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${address} — ${note}\n`, "utf8");
  }

  private enforceCap(): void {
    if (this.entries.length <= this.max) return;
    const overflow = this.entries.splice(0, this.entries.length - this.max);
    for (const e of overflow) this.byAddress.delete(e.address);
    const files = [...new Set(overflow.map((e) => e.address.split(":")[0]))];
    this.indexPath = files.join(", ");
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `[index] ${this.indexPath} (folded ${overflow.length})\n`, "utf8");
  }
}
```

- [ ] **Step 4: Run → PASS (4 tests). `bun run typecheck` clean.**

- [ ] **Step 5: Commit**
```bash
git add src/core/context/ledger.ts tests/core/ledger.test.ts
git commit -m "feat(context): ContextLedger — durable address ledger with dedupe/cap/staleness (OO-3/OO-8)"
```

---

## Task 3: Address extraction from tool results

**Files:**
- Create: `src/core/context/ledger-parse.ts`
- Test: `tests/core/ledger-parse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/ledger-parse.test.ts
import { describe, it, expect } from "vitest";
import { addressesFromToolResult } from "../../src/core/context/ledger-parse";

describe("addressesFromToolResult", () => {
  it("extracts path:line from grep output (the findings)", () => {
    const out = "src/a.ts:1800:NEEDLE_A_111 marker\nsrc/a.ts:1810:other";
    const got = addressesFromToolResult("grep", { pattern: "NEEDLE_A" }, out);
    expect(got).toContainEqual({ address: "src/a.ts:1800", note: "NEEDLE_A_111 marker" });
    expect(got.some((g) => g.address === "src/a.ts:1810")).toBe(true);
  });

  it("records the path for read_file with its range", () => {
    const got = addressesFromToolResult("read_file", { path: "corpus/big.txt" }, "── corpus/big.txt (.txt, 4000 lines, lines 1-300)");
    expect(got[0].address).toContain("corpus/big.txt");
  });

  it("records url for web tools", () => {
    const got = addressesFromToolResult("web_fetch", { url: "https://x.example/p" }, "body");
    expect(got[0].address).toBe("https://x.example/p");
  });

  it("returns nothing for non-source tools", () => {
    expect(addressesFromToolResult("bash", { command: "ls" }, "out")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/core/context/ledger-parse.ts`**

```ts
// src/core/context/ledger-parse.ts
// Извлекает адреса-находки из результата тула (OO-6): значения `grep`
// (path:line), диапазон `read_file`, URL веб-тулов. Никаких LLM-вызовов.
export interface AddressNote {
  address: string;
  note: string;
}

const SEARCH_TOOLS = new Set(["grep", "search", "grep_js", "rg"]);
const READ_TOOLS = new Set(["read_file", "file_info"]);
const URL_TOOLS = new Set(["web_fetch", "web_browse", "fetch"]);

/** Максимум адресов-находок с одного результата (сужение: страница grep). */
const MAX_FINDINGS_PER_RESULT = 20;

export function addressesFromToolResult(
  name: string,
  args: Record<string, unknown>,
  content: string,
): AddressNote[] {
  if (SEARCH_TOOLS.has(name)) {
    const out: AddressNote[] = [];
    for (const line of content.split("\n")) {
      // формат: <path>:<line>:<text>
      const m = line.match(/^(.+?):(\d+):(.*)$/);
      if (!m) continue;
      out.push({ address: `${m[1]}:${m[2]}`, note: m[3].trim().slice(0, 120) });
      if (out.length >= MAX_FINDINGS_PER_RESULT) break;
    }
    return out;
  }
  if (READ_TOOLS.has(name)) {
    const path = typeof args.path === "string" ? args.path : undefined;
    if (!path) return [];
    const head = content.split("\n").find((l) => l.trim()) ?? "";
    const range = head.match(/lines (\d+)-(\d+)/);
    const address = range ? `${path}:${range[1]}` : path;
    return [{ address, note: range ? `lines ${range[1]}-${range[2]}` : "read" }];
  }
  if (URL_TOOLS.has(name)) {
    const url = typeof args.url === "string" ? args.url : undefined;
    return url ? [{ address: url, note: "fetched" }] : [];
  }
  return [];
}
```

- [ ] **Step 4: Run → PASS. Commit**
```bash
git add src/core/context/ledger-parse.ts tests/core/ledger-parse.test.ts
git commit -m "feat(context): addressesFromToolResult — path:line/url findings from tool output (OO-6)"
```

---

## Task 4: Wire the ledger into `ContextManager`

**Files:**
- Modify: `src/core/context/manager.ts`
- Modify: `src/core/bootstrap/session-phase.ts`, `src/core/bootstrap/session-runner.ts`
- Test: `tests/core/ledger-manager.test.ts`

- [ ] **Step 1: Write the failing test** (integration: after a compaction the pointer is in the block, entries persist to the file and survive a second compaction)

```ts
// tests/core/ledger-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../../src/core/context/manager";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mma-ledm-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function toolMsg(name: string, args: Record<string, unknown>, content: string) {
  return { role: "tool" as const, name, content, tool_call_id: "t", arguments: args };
}

describe("ContextManager ledger", () => {
  it("persists a grep finding to the notes file and pins a pointer after compaction", () => {
    const cm = new ContextManager(2000);
    const notes = join(dir, "NOTES.md");
    cm.configureLedger(notes, 200);

    for (let i = 0; i < 30; i++) {
      cm.addMessage({ role: "user", content: `turn ${i}` });
      cm.addMessage(toolMsg("grep", { pattern: "NEEDLE" }, "corpus/hard-b.txt:3300:NEEDLE_B_222 marker"));
    }
    cm.compact(); // public compaction entry (use the real method name)
    expect(existsSync(notes)).toBe(true);
    expect(readFileSync(notes, "utf8")).toContain("corpus/hard-b.txt:3300");
    const block = cm.getCompactionBlockForTest(); // see Step 3 for accessor
    expect(block).toContain("[Notes:");
    expect(block).not.toContain("NEEDLE_B_222"); // content lives in the file, not the block
  });
});
```

- [ ] **Step 2: Run → FAIL** (no `configureLedger`). Adjust test to the real compaction entry point/method names after reading `manager.ts` (`compact()` is private — use the existing public `compactIfNeeded`/`compact` wrapper the tests already use; check `tests/core/context-calibration.test.ts` for the exact public API).

- [ ] **Step 3: Implement in `manager.ts`**

  - Import: `import { ContextLedger } from "./ledger";` and `import { addressesFromToolResult } from "./ledger-parse";`
  - Field: `private ledger: ContextLedger | null = null;`
  - Method:
    ```ts
    /** OO-3: подключить durable леджер адресов (путь из contextBudget.notesPath). */
    configureLedger(filePath: string, max: number): void {
      this.ledger = new ContextLedger(filePath, max);
      this.ledger.load();
    }
    ```
  - In `absorbToolLedger` (or a new `absorbLedgerAddresses(messages)` called from the same place, `manager.ts:591`/`:887`), for each `role:"tool"` message call `addressesFromToolResult(m.name, m.arguments ?? {}, text)` and `this.ledger?.record(a.address, a.note)`.
  - OO-8: in `addMessage` (`manager.ts:391`), if the message is a write/edit tool result (`write_file`/`edit_file`/`str_replace`), call `this.ledger?.markStale(<path arg>)` for the touched path (derive from `msg.arguments.path`).
  - In `buildCompactionBlock` (`manager.ts:680`), replace the `[Tool ledger]` block with the ledger pointer:
    ```ts
    const pointer = this.ledger?.pointerLine();
    if (pointer) parts.push(pointer);
    ```
    Keep the legacy `toolLedger` behavior only when no ledger is configured (backward compatible).
  - In `reset/clear` (`manager.ts:1017`), do **not** drop the ledger (it is durable); only clear in-memory tool ledger.

- [ ] **Step 4: Bootstrap wiring** — in `session-phase.ts` (after `new ContextManager(...)` at line 187) and `session-runner.ts` (line ~193), call:
  ```ts
  contextManager.configureLedger(
    join(baseDir, config.contextBudget.notesPath ?? "NOTES.md"),
    config.contextBudget.ledgerMax ?? 200,
  );
  ```
  (`join` already imported there or add it.)

- [ ] **Step 5: Run `bun test tests/core/ledger-manager.test.ts` → PASS; then `bun test` + `bun run quality`.**

- [ ] **Step 6: Commit**
```bash
git add -A
git commit -m "feat(context): wire durable ledger into ContextManager (OO-3/OO-8)"
```

---

## Task 5: Compaction-without-progress detector + diagnostic (INV-15)

**Files:**
- Modify: `src/core/context/manager.ts`, `src/core/bootstrap/tool-context.ts` (reuse sink pattern), `docs/agents/observability.md`
- Test: `tests/core/compaction-progress.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/compaction-progress.test.ts
import { describe, it, expect } from "vitest";
import { ContextManager } from "../../src/core/context/manager";

describe("compaction progress detector", () => {
  it("flags two consecutive compactions with no ledger progress", () => {
    const cm = new ContextManager(1500);
    const seen: string[] = [];
    cm.setProgressDiagnosticSink((d) => seen.push(d.kind));
    // drive ≥2 compactions without any grep/read findings entering the ledger
    for (let i = 0; i < 80; i++) cm.addMessage({ role: "user", content: `x ${i}` });
    cm.compact();
    for (let i = 0; i < 80; i++) cm.addMessage({ role: "user", content: `y ${i}` });
    cm.compact();
    expect(seen).toContain("no-progress");
  });
});
```

- [ ] **Step 2: Implement** — in `ContextManager`:
  - Track `private lastCompactLedgerSize = 0; private noProgressStreak = 0;`
  - On each compaction: `const grew = (this.ledger?.size() ?? 0) > this.lastCompactLedgerSize;` If `!grew` → `noProgressStreak++` else `0`; update `lastCompactLedgerSize`.
  - If `noProgressStreak >= 2` → call `this.progressSink?.({ kind: "no-progress", compactions: noProgressStreak })`.
  - Add `setProgressDiagnosticSink(fn)`.
  - Wire the sink in bootstrap (`session-phase.ts`, `session-runner.ts`) to write a session diagnostic `context_degraded` (extend `session-logger.ts`/`session/store.ts` union like `admission_degraded`), via `sessionManager.appendLog`. Add the `context_degraded` row to `docs/agents/observability.md`.

- [ ] **Step 3: Run tests + `bun run quality`. Commit**
```bash
git add -A
git commit -m "feat(context): compaction-without-progress diagnostic (INV-15)"
```

---

## Task 6: Live acceptance — re-run the extreme scenario

**Files:** `_testing/live/ctx-probe/` (sandbox; not committed code)

- [ ] Re-run: `bun run run-scenario.ts hard-multi-extreme prompts/hard-multi-2.txt --timeout 600 --threshold 0.15`
- [ ] **Acceptance:** agent returns `NEEDLE_A_111`, `NEEDLE_B_222`, `NEEDLE_C_333`, the correct big-report heading, and decoy count `0`; compactions may be >0; session `exit=0`; the notes file contains the `path:line` findings; the compaction block contains `[Notes:` (not raw content).
- [ ] If it still fails: compare the notes file against the answers; the failure is then a plumbing bug (findings not reaching the ledger) — fix in Task 4, not a model issue.

---

## Self-Review

**Spec coverage:** OO-3 (durable ledger, pointer) → Tasks 2/4; OO-6 (harness writes addresses) → Tasks 2/3/4; OO-8 (staleness) → Tasks 2/4; loop/деградация (§6.2) → Task 5; config keys → Task 1; live acceptance → Task 6.

**Placeholders:** none — every task carries code/commands. Task 2 `pointerLine` test uses a loose regex; implementers should tighten to the real `shortPath` output.

**Type consistency:** `ContextLedger(filePath, max)`, `record/load/markStale/isStale/pointerLine/render/size`; `addressesFromToolResult(name, args, content) → AddressNote[]`; `ContextManager.configureLedger(path, max)` — consistent across tasks. `AddressNote {address, note}` matches `ContextLedger.record(address, note)`.

**Known risk:** `manager.ts` is large; wiring may push it over its file-size ceiling → if so, extract the ledger-absorb/`addressesFromToolResult` call into a small helper module rather than growing `manager.ts` (do NOT raise the ceiling).
