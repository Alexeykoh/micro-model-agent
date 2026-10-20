# `scan_corpus` — Wave W-d (orchestrated corpus scan, OO-4/OO-9) Implementation Plan

> **Статус:** исполнено (2026-10-20) — `src/core/context/scan-corpus.ts` (MAP через
> `runChunkQuery` + рекурсивный REDUCE), тул `scan_corpus` с `security`-декларацией,
> тесты `tests/core/scan-corpus.test.ts` и `tests/tools/scan-corpus.test.ts`.
> Чекбоксы проставлены по факту. Не сделано: опциональный живой smoke-прогон.

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** One harness-orchestrated tool `scan_corpus` that answers a question over MANY sources by locate → partition → MAP (reusing `runChunkQuery`) → recursive REDUCE, returning bounded evidence — the "orders of magnitude" engine (OO-4), with bounded fanout/hierarchical partition (OO-9). Not a third engine: MAP reuses `runChunkQuery` (`src/core/context/chunk-query.ts`).

**Tech Stack:** Bun + TS strict, vitest, Biome; i18n via `t()`; tool registration in `src/tools/index.ts`; security decl enforced by `tests/tools/security-decl.test.ts`.

**Base:** branch `feat/scan-corpus` off `docs/architecture-v2`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/core/context/scan-corpus.ts` | `scanCorpus()` engine: partition + MAP(scan one file) + recursive REDUCE | Create |
| `src/tools/scan-corpus.ts` | `scan_corpus` tool wrapper (scope-checked path, collect files, call engine) | Create |
| `src/tools/index.ts` | register `scanCorpusTool` | Modify |
| `src/i18n/en.json`, `src/i18n/ru.json` | tool labels/errors | Modify |
| `tests/core/scan-corpus.test.ts` | engine tests (mock provider, injected readFile) | Create |
| `tests/tools/scan-corpus.test.ts` | tool tests (scope reject, happy path) | Create |

---

## Task 1: `scanCorpus()` engine

**Files:** Create `src/core/context/scan-corpus.ts`; Test `tests/core/scan-corpus.test.ts`.

- [x] **Step 1: failing test** — `tests/core/scan-corpus.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { scanCorpus } from "../../src/core/context/scan-corpus";
import type { Message } from "../../src/llm/provider";

// Provider that echoes the query with a marker derived from the text it saw.
function mockProvider(): any {
  return {
    chat: async function* (messages: Message[]) {
      const user = messages.find((m) => m.role === "user")?.content as string;
      const isSynth = messages.find((m) => m.role === "system")?.content === undefined
        ? false
        : (messages.find((m) => m.role === "system")!.content as string).includes("combining evidence");
      const text = user.includes("Text:") ? user.split("Text:")[1] : user;
      if (isSynth) yield { type: "text", content: "SYNTH" };
      else yield { type: "text", content: `FINDING:${text.trim().slice(0, 20)}` };
    },
  };
}

describe("scanCorpus", () => {
  it("maps each file to a finding and reduces to a synthesis", async () => {
    const files = { "a.md": "alpha content", "b.md": "beta content" };
    const res = await scanCorpus(mockProvider(), {
      question: "q",
      files: Object.keys(files),
      readFile: (p) => files[p],
      maxFanout: 8,
    });
    expect(res.scanned).toBe(2);
    expect(res.findings.map((f) => f.path).sort()).toEqual(["a.md", "b.md"]);
    expect(res.synthesis).toBe("SYNTH");
  });

  it("bounds fanout by recursively partitioning directories (OO-9)", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`d${i % 2}/f${i}.md`] = `content ${i}`;
    const res = await scanCorpus(mockProvider(), {
      question: "q",
      files: Object.keys(files),
      readFile: (p) => files[p],
      maxFanout: 2,
    });
    expect(res.scanned).toBe(6); // all reached via hierarchy
    expect(res.findings.length).toBe(6);
    expect(res.maxFanoutObserved).toBeLessThanOrEqual(2);
  });

  it("skips unreadable files without failing the scan", async () => {
    const res = await scanCorpus(mockProvider(), {
      question: "q",
      files: ["ok.md", "gone.md"],
      readFile: (p) => {
        if (p === "gone.md") throw new Error("ENOENT");
        return "ok content";
      },
    });
    expect(res.findings.map((f) => f.path)).toEqual(["ok.md"]);
  });
});
```

- [x] **Step 2: run → FAIL** (module missing).

- [x] **Step 3: implement `src/core/context/scan-corpus.ts`**

```ts
// src/core/context/scan-corpus.ts
// Оркестратор скана корпуса (OO-4/OO-9): locate → partition → MAP(один файл
// через runChunkQuery) → рекурсивный REDUCE. Не третий движок: MAP/REDUCE
// переиспользуют runChunkQuery. Fanout ограничен; при переполнении — иерархия.
import type { LLMProvider } from "../../llm/provider";
import type { Logger } from "../../logger/app-logger";
import { runChunkQuery } from "./chunk-query";
import { errMsg } from "../../utils";

export interface ScanOptions {
  question: string;
  files: string[];
  readFile: (path: string) => string;
  /** Макс. веток MAP на уровне (OO-9). */
  maxFanout?: number;
  /** Макс. глубина партиции/редукции. */
  maxDepth?: number;
  maxParallel?: number;
  chunkChars?: number;
  logger?: Logger;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface ScanFinding { path: string; answer: string; }
export interface ScanResult {
  findings: ScanFinding[];
  synthesis: string;
  scanned: number;
  /** Наибольшее число одновременных MAP-веток (для тестов/тюнинга). */
  maxFanoutObserved: number;
}

const DEFAULT_FANOUT = 8;
const DEFAULT_DEPTH = 3;

/** Группирует пути по каталогу (для иерархической партиции). */
function groupByDir(files: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const f of files) {
    const i = Math.max(f.lastIndexOf("/"), f.lastIndexOf("\\"));
    const dir = i >= 0 ? f.slice(0, i) : "";
    const arr = m.get(dir) ?? [];
    arr.push(f);
    m.set(dir, arr);
  }
  return m;
}

/** MAP одного файла: ответ на вопрос по его содержимому (runChunkQuery). */
async function mapFile(
  provider: LLMProvider,
  path: string,
  opts: ScanOptions,
  maxParallel: number,
): Promise<ScanFinding | null> {
  let text: string;
  try {
    text = opts.readFile(path);
  } catch (e) {
    opts.logger?.debug(`scanCorpus: skip ${path}: ${errMsg(e)}`);
    return null;
  }
  const r = await runChunkQuery(provider, text, opts.question, {
    synthesize: true,
    maxParallel,
    chunkChars: opts.chunkChars,
    logger: opts.logger,
    sessionId: opts.sessionId,
    signal: opts.signal,
  });
  return { path, answer: r.synthesis || r.answers.join("\n") };
}

async function mapLevel(
  provider: LLMProvider,
  files: string[],
  opts: ScanOptions,
  fanout: number,
  depth: number,
  state: { scanned: number; maxFanoutObserved: number },
): Promise<ScanFinding[]> {
  const maxParallel = Math.min(opts.maxParallel ?? fanout, fanout);
  // Иерархия (OO-9): корпус больше fanout → партиционируем по каталогам и рекурсируем.
  if (files.length > fanout && depth > 0) {
    const groups = groupByDir(files);
    const buckets = [...groups.values()];
    const out: ScanFinding[] = [];
    let inFlight = 0;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(maxParallel, buckets.length) }, async () => {
      while (cursor < buckets.length) {
        const i = cursor++;
        inFlight++;
        state.maxFanoutObserved = Math.max(state.maxFanoutObserved, inFlight);
        try {
          const part = await mapLevel(provider, buckets[i], opts, fanout, depth - 1, state);
          out.push(...part);
        } finally {
          inFlight--;
        }
      }
    });
    await Promise.all(workers);
    return out;
  }
  const out: ScanFinding[] = [];
  let inFlight = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(maxParallel, files.length) }, async () => {
    while (cursor < files.length) {
      const i = cursor++;
      inFlight++;
      state.maxFanoutObserved = Math.max(state.maxFanoutObserved, inFlight);
      try {
        const f = await mapFile(provider, files[i], opts, maxParallel);
        if (f) out.push(f);
      } finally {
        inFlight--;
      }
    }
  });
  await Promise.all(workers);
  state.scanned += out.length;
  return out;
}

/** REDUCE: сводит находки; при переполнении — рекурсивно деревом. */
async function reduce(
  provider: LLMProvider,
  findings: ScanFinding[],
  opts: ScanOptions,
  fanout: number,
  depth: number,
): Promise<string> {
  if (findings.length === 0) return "";
  const text = findings.map((f) => `## ${f.path}\n${f.answer}`).join("\n\n");
  if (findings.length <= fanout || depth <= 0) {
    const r = await runChunkQuery(provider, text, opts.question, {
      synthesize: true,
      logger: opts.logger,
      sessionId: opts.sessionId,
      signal: opts.signal,
    });
    return r.synthesis || r.answers.join("\n");
  }
  // Разбить на группы по fanout и свести каждую, затем свести результаты.
  const groups: ScanFinding[][] = [];
  for (let i = 0; i < findings.length; i += fanout) groups.push(findings.slice(i, i + fanout));
  const partials: ScanFinding[] = [];
  for (const g of groups) partials.push({ path: `(${g.length} findings)`, answer: await reduce(provider, g, opts, fanout, depth - 1) });
  return reduce(provider, partials, opts, fanout, depth - 1);
}

/** Скан корпуса: MAP по файлам + REDUCE. Возвращает находки и синтез. */
export async function scanCorpus(provider: LLMProvider, opts: ScanOptions): Promise<ScanResult> {
  const fanout = Math.max(1, opts.maxFanout ?? DEFAULT_FANOUT);
  const depth = Math.max(0, opts.maxDepth ?? DEFAULT_DEPTH);
  const state = { scanned: 0, maxFanoutObserved: 0 };
  const findings = await mapLevel(provider, opts.files, opts, fanout, depth, state);
  const synthesis = await reduce(provider, findings, opts, fanout, depth);
  return { findings, synthesis, scanned: state.scanned, maxFanoutObserved: state.maxFanoutObserved };
}
```

Notes: verify `errMsg`/`Logger`/`LLMProvider`/`Message` real import paths from siblings (`src/core/context/chunk-query.ts`, `src/utils.ts`). Keep the module pure w.r.t. fs (readFile injected).

- [x] **Step 4: run → PASS** (`bun test tests/core/scan-corpus.test.ts`). `bun run typecheck`. `bunx biome check` on the two files. No `as any` in `src/`.

- [x] **Step 5: commit** `feat(context): scanCorpus orchestration engine (OO-4/OO-9)`

---

## Task 2: `scan_corpus` tool + registration + i18n

**Files:** Create `src/tools/scan-corpus.ts`, `tests/tools/scan-corpus.test.ts`; Modify `src/tools/index.ts`, `src/i18n/en.json`, `src/i18n/ru.json`.

- [x] **Step 1: failing test** `tests/tools/scan-corpus.test.ts` — assert: `scanCorpusTool.name === "scan_corpus"`; `parameters.required` includes `question` and `path`; handler rejects a path outside scope (returns `success:false` with `SCOPE`); happy path over a temp dir returns a synthesis (mock provider + temp files, scope includes the dir). Model the test on `tests/tools/chunk-query.test.ts` (same mock-provider and baseCtx style).

- [x] **Step 2: implement** `src/tools/scan-corpus.ts`:
  - `name: "scan_corpus"`, `security: { caps: [{ fs: "read" }], pathArgs: ["path"] }`, `tags: ["research"]`, `timeoutMs: 300000`, `boundedOutput: true`.
  - params: `question` (string, required), `path` (string, required — file or directory), `max_fanout` (number, optional).
  - handler: scope-check `path` via `isPathInScope(ctx.baseDir, path, ctx.scope)`; collect files (file → `[path]`; dir → walk recursively, bounded to e.g. 200 files, skipping `node_modules`/`.git`); call `scanCorpus(ctx.llmProvider, { question, files, readFile: (p) => readFileSync(p, "utf8"), maxFanout, logger: ctx.logger, sessionId: ctx.sessionId })`; output = lines `path → answer` + `Synthesis:` + synthesis, bounded.
  - i18n keys (en+ru, symmetric): `tool.scan_corpus_no_question`, `tool.scan_corpus_no_provider`, and a header `tool.scan_corpus_result`.

- [x] **Step 3: register** in `src/tools/index.ts`: import `scanCorpusTool` and add to both arrays (the `tools` list at ~line 104-112 and wherever `chunkQueryTool` appears at ~61-69), following `chunkQueryTool`.

- [x] **Step 4: verify** `bun test tests/tools/scan-corpus.test.ts tests/tools/security-decl.test.ts tests/i18n.test.ts`; then `bun test` + `bun run quality` green. No `as any` in `src/`.

- [x] **Step 5: commit** `feat(tools): scan_corpus tool (OO-4/OO-9)`

---

## Task 3: live smoke (manual)

- [x] Run a live smoke via `_testing/live/ctx-probe` (isolated `MMA_CONFIG_DIR`) with a small multi-file corpus and a question answerable by scanning; assert the tool was called and returned a plausible synthesis. (Optional; the unit + tool tests are the gate.)

---

## Self-Review
- OO-4 (delegation over dumping) → Task 1 MAP/REDUCE + Task 2 tool. OO-9 (bounded fanout, hierarchy) → `mapLevel` partition-by-dir + `maxFanoutObserved` test. Mechanism boundary (§4.6: reuse, not a third engine) → imports `runChunkQuery`. Security decl → `pathArgs: ["path"]` + scope test.
- No placeholders. Types consistent (`ScanOptions`/`ScanFinding`/`ScanResult`, `scanCorpus`).
- Risk: `maxFanoutObserved` under hierarchy counts in-flight bucket-workers; ensure the test threshold reflects the fanout bound.
