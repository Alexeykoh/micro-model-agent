# MMA Web Mode — Implementation Plan (Phase 1 + 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a reusable Host seam from the REPL and ship a first-class `mma web` mode that serves a chat UI over SSE/REST without a TTY.

**Architecture:** A `Host` interface (superset of today's `HostBridge`) is extracted from `Repl` so terminal and web are two implementations over one `Agent`. `WebHost` + a `src/modules/webui/` module (app creation split from `listen()`, per rule #13) provide the browser surface; static assets are served verbatim. Later phases (sidebar, settings, questions, bundler) build on this seam.

**Tech Stack:** Bun + TypeScript (ES2022, NodeNext), `node:http` (SSE + REST), vitest via `bun test`, commander, `picocolors`, existing `OutputBus`/`OutputChannel`.

**Spec:** [`design.md`](./design.md) · **Mockup:** [`mockups/layout-v6.html`](./mockups/layout-v6.html)

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/core/host.ts` | `Host` interface, `HostStateSnapshot`, `createHostBridge` (moved from `repl.ts`) |
| `src/cli/repl.ts` | Implements `Host`; re-exports `createHostBridge` for compatibility |
| `src/modules/webui/state.ts` | `WebUiState` + `broadcast`/`pushChunk`/`flush` SSE primitives |
| `src/modules/webui/server.ts` | `handleRequest`, `startServer`, `stopServer`, auth/CSRF/limits (app≠listen) |
| `src/modules/webui/assets/index.html` | Chat page markup |
| `src/modules/webui/assets/styles.css` | Theme (CSS variables, dark/light) |
| `src/modules/webui/assets/app.js` | SSE client + rendering + input |
| `src/core/web-host.ts` | `WebHost implements Host` (submit/interrupt/executeCommand/state/PromptIO) |
| `src/cli/web-command.ts` | `mma web` subcommand: bootstrap → WebHost → WebUiModule → block |
| `src/cli/commands.ts` | Register `web` subcommand |
| `src/cli/main.ts` | Dispatch `web` before REPL/one-shot branches |
| `tests/web-host.test.ts` | Host seam unit tests |
| `tests/webui-server.test.ts` | Server contract tests |
| `tests/webui-auth.test.ts` | Token/CSRF/limits tests |

**Phase boundary:** Phase 1 (Tasks 1–4) changes no user-visible behavior — `bun test` + `tsc` must stay green after each task. Phase 2 (Tasks 5–12) delivers a working `mma web`.

---

## Phase 1 — Host seam

### Task 1: Define the `Host` interface

**Files:**
- Create: `src/core/host.ts`
- Test: `tests/host-types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/host-types.test.ts
import { describe, it, expect } from "vitest";
import { createHostBridge } from "../src/core/host";

describe("core/host", () => {
  it("createHostBridge rejects submit while busy", async () => {
    const bridge = createHostBridge({
      isBusy: () => true,
      addPendingImage: () => {},
      runAgent: async () => "ran",
      interruptRun: () => {},
    });
    await expect(bridge.submit("hi")).rejects.toThrow("agent is busy");
  });

  it("createHostBridge forwards images then runs", async () => {
    const images: string[] = [];
    let ran = "";
    const bridge = createHostBridge({
      isBusy: () => false,
      addPendingImage: (u) => images.push(u),
      runAgent: async (t) => {
        ran = t;
        return "ok";
      },
      interruptRun: () => {},
    });
    const out = await bridge.submit("hello", { images: ["data:image/png;base64,AAA"] });
    expect(out).toBe("ok");
    expect(ran).toBe("hello");
    expect(images).toEqual(["data:image/png;base64,AAA"]);
  });

  it("createHostBridge interrupt is a no-op when idle", () => {
    let interrupted = false;
    const bridge = createHostBridge({
      isBusy: () => false,
      addPendingImage: () => {},
      runAgent: async () => "x",
      interruptRun: () => {
        interrupted = true;
      },
    });
    bridge.interrupt();
    expect(interrupted).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/host-types.test.ts`
Expected: FAIL — cannot resolve `../src/core/host`.

- [ ] **Step 3: Create `src/core/host.ts`**

Move the implementation verbatim from `src/cli/repl.ts:89-107` and add the `Host` interface:

```ts
import type { OutputEvent } from "../output/types";
import { defaultOutputBus } from "../output/bus";
import type { HostBridge, HostBridgeSubmitOptions } from "../modules/types";

/** Snapshot a Host can render into a sidebar/topbar. Fields are best-effort:
 *  absent when the underlying module is not available (e.g. no session yet). */
export interface HostStateSnapshot {
  busy: boolean;
  sessionId?: string;
  sessionName?: string;
  model?: string;
  provider?: string;
  contextUsed?: number;
  contextLimit?: number;
  costUsd?: number;
  compactionCount?: number;
  plan?: {
    steps: { text: string; status: "pending" | "in_progress" | "done" | "failed" }[];
    currentIndex: number;
  } | null;
}

/**
 * Full host surface. `HostBridge` (plugin-facing, narrow) stays the plugin
 * contract; `Host` adds the pieces web mode needs. `Repl` and `WebHost` are the
 * two implementations.
 */
export interface Host extends HostBridge {
  /** Execute a slash command line (e.g. "/status") through the shared handler map. */
  executeCommand(line: string): Promise<void>;
  /** Current state for sidebar/topbar rendering. */
  getState(): HostStateSnapshot;
}

export interface CreateHostBridgeOptions {
  isBusy: () => boolean;
  addPendingImage: (dataUrl: string) => void;
  runAgent: (text: string) => Promise<unknown>;
  interruptRun: () => void;
}

export function createHostBridge(opts: CreateHostBridgeOptions): HostBridge {
  return {
    isBusy: opts.isBusy,
    async submit(text: string, o?: HostBridgeSubmitOptions) {
      if (opts.isBusy()) throw new Error("agent is busy");
      for (const url of o?.images ?? []) opts.addPendingImage(url);
      return opts.runAgent(text);
    },
    interrupt() {
      if (opts.isBusy()) opts.interruptRun();
    },
    subscribeOutput: (fn: (ev: OutputEvent) => void) => defaultOutputBus.subscribe(fn),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/host-types.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `tsc --noEmit`
Expected: PASS (new file compiles; no importers yet).

- [ ] **Step 6: Commit**

```bash
git add src/core/host.ts tests/host-types.test.ts
git commit -m "feat(host): add Host interface and shared createHostBridge"
```

---

### Task 2: Re-point `Repl` at the shared `createHostBridge`

**Files:**
- Modify: `src/cli/repl.ts:83-107` (delete local `createHostBridge`, import + re-export)
- Test: `tests/repl-host-bridge.test.ts` (existing behavior guard)

- [ ] **Step 1: Write the failing test**

```ts
// tests/repl-host-bridge.test.ts
import { describe, it, expect } from "vitest";
import { createHostBridge } from "../src/cli/repl";

describe("repl re-export", () => {
  it("still exports createHostBridge (compat)", () => {
    expect(typeof createHostBridge).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/repl-host-bridge.test.ts`
Expected: PASS currently (function exists). This test guards the move; keep it.

- [ ] **Step 3: Replace the local function with an import + re-export**

In `src/cli/repl.ts`, delete the body at lines 83–107 and add near the imports:

```ts
import { createHostBridge } from "../core/host";
export { createHostBridge };
```

Keep the doc comment above the re-export if desired. Remove now-unused `HostBridge` import only if nothing else in the file uses it (grep first: `rg "HostBridge" src/cli/repl.ts`).

- [ ] **Step 4: Run the full suite**

Run: `bun test`
Expected: PASS — no behavior change.

- [ ] **Step 5: Typecheck**

Run: `tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/repl.ts tests/repl-host-bridge.test.ts
git commit -m "refactor(repl): use shared createHostBridge from core/host"
```

---

### Task 3: Add `executeCommand` and `getState` to `Repl`

**Files:**
- Modify: `src/cli/repl.ts` (add public methods)
- Test: `tests/repl-host-methods.test.ts`

The REPL already has a command handler map (`this.commands`, `src/cli/repl.ts:887+`) and an execution module. Expose them through two methods so the web host can reuse them.

- [ ] **Step 1: Write the failing test**

```ts
// tests/repl-host-methods.test.ts
import { describe, it, expect } from "vitest";

// Repl is heavyweight to construct; test the pure mapping helpers it delegates to.
import { planSnapshotFromModule } from "../src/core/host-plan";

describe("host plan snapshot", () => {
  it("maps an active plan to a HostStateSnapshot plan", () => {
    const snap = planSnapshotFromModule({
      steps: [
        { text: "setup", status: "done" },
        { text: "build", status: "in_progress" },
        { text: "ship", status: "pending" },
      ],
      currentIndex: 1,
    });
    expect(snap).toEqual({
      steps: [
        { text: "setup", status: "done" },
        { text: "build", status: "in_progress" },
        { text: "ship", status: "pending" },
      ],
      currentIndex: 1,
    });
  });

  it("returns null for a missing plan", () => {
    expect(planSnapshotFromModule(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/repl-host-methods.test.ts`
Expected: FAIL — cannot resolve `../src/core/host-plan`.

- [ ] **Step 3: Create `src/core/host-plan.ts`**

```ts
import type { HostStateSnapshot } from "./host";

export interface ActivePlanLike {
  steps: { text: string; status: "pending" | "in_progress" | "done" | "failed" }[];
  currentIndex: number;
}

/** Pure projection of an ExecutionModule plan into a HostStateSnapshot plan. */
export function planSnapshotFromModule(
  plan: ActivePlanLike | null | undefined,
): HostStateSnapshot["plan"] {
  if (!plan) return null;
  return {
    steps: plan.steps.map((s) => ({ text: s.text, status: s.status })),
    currentIndex: plan.currentIndex,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/repl-host-methods.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add methods to `Repl`**

In `src/cli/repl.ts`, add public methods (place after `runAgent`):

```ts
  /** Host: run a slash command through the same handler map as typed input. */
  async executeCommand(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/")) return;
    await this.handleSlashCommand(trimmed);
  }

  /** Host: current plan/session/model snapshot for UI surfaces. */
  getState(): HostStateSnapshot {
    const plan = planSnapshotFromModule(
      this.execModule?.getActivePlan?.() as Parameters<typeof planSnapshotFromModule>[0],
    );
    const meta = this.sessionManager?.getActiveMeta?.();
    return {
      busy: this.agentRunning,
      sessionId: meta?.id,
      sessionName: meta?.name,
      model: this.config.model,
      provider: this.config.provider?.active,
      plan,
    };
  }
```

Import at top: `import { planSnapshotFromModule } from "../core/host-plan";` and `import type { HostStateSnapshot } from "../core/host";`.

Replace `this.handleSlashCommand(trimmed)` with the actual existing dispatcher name — grep: `rg "handleSlashCommand|handleCommand|async handle" src/cli/repl.ts`. Use whatever the real method is; if commands are dispatched inline in `start()`, extract that dispatch into a private `dispatchCommand(line)` and call it from both places (no behavior change).

- [ ] **Step 6: Run suite + typecheck**

Run: `bun test && tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/repl.ts src/core/host-plan.ts tests/repl-host-methods.test.ts
git commit -m "feat(host): Repl exposes executeCommand + getState"
```

---

### Task 4: Type-assert that `Repl` satisfies `Host`

**Files:**
- Modify: `src/cli/repl.ts` (class `implements` clause)
- Test: compile-only

- [ ] **Step 1: Add the interface to the class declaration**

Change `export class Repl implements ReplContext {` to `export class Repl implements ReplContext, Host {`. Add `import type { Host } from "../core/host";`.

- [ ] **Step 2: Typecheck**

Run: `tsc --noEmit`
Expected: PASS. If it fails, `Repl` is missing `isBusy`/`submit`/`interrupt`/`subscribeOutput` — add thin methods delegating to the existing bridge (`this.bridge`), or make `Host` extend only what is implemented and keep `HostBridge` separately. Prefer adding delegating methods:

```ts
  isBusy(): boolean { return this.agentRunning; }
  submit(text: string, o?: HostBridgeSubmitOptions): Promise<unknown> {
    return this.bridge.submit(text, o);
  }
  interrupt(): void { this.bridge.interrupt(); }
  subscribeOutput(fn: (ev: OutputEvent) => void): () => void {
    return defaultOutputBus.subscribe(fn);
  }
```

- [ ] **Step 3: Run suite + typecheck**

Run: `bun test && tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/cli/repl.ts
git commit -m "feat(host): Repl implements Host"
```

---

## Phase 2 — `mma web`

### Task 5: WebUi module state + server skeleton (app ≠ listen)

**Files:**
- Create: `src/modules/webui/state.ts`, `src/modules/webui/server.ts`
- Test: `tests/webui-server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/webui-server.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { handleRequest, startServer, stopServer } from "../src/modules/webui/server";
import { createWebUiState, broadcast } from "../src/modules/webui/state";

const assets = { html: "<h1>hi</h1>", css: "body{}", js: "//ok" };

function get(url: string): Promise<{ status: number; body: string }> {
  return fetch(url).then(async (r) => ({ status: r.status, body: await r.text() }));
}

describe("webui server", () => {
  afterEach(() => stopServer());

  it("serves static assets", async () => {
    const url = await startServer(assets);
    const page = await get(url + "/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("hi");
    const js = await get(url + "/app.js");
    expect(js.body).toBe("//ok");
  });

  it("404s unknown paths", async () => {
    const url = await startServer(assets);
    expect((await get(url + "/nope")).status).toBe(404);
  });

  it("handleRequest works against an explicit state (app≠listen)", async () => {
    const s = createWebUiState();
    const srv = createServer((req, res) => handleRequest(req, res, assets, s));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const res = await get(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    srv.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/webui-server.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Create `src/modules/webui/state.ts`**

```ts
import type { Server, ServerResponse } from "node:http";
import type { Host } from "../../core/host";

export interface WebUiAssets { html: string; css: string; js: string; }

export interface WebUiState {
  server: Server | null;
  starting: Promise<string> | null;
  url: string;
  host: string;
  token: string | null;
  clients: Set<ServerResponse>;
  bridge: Host | null;
  busy: boolean;
  lastPostTs: number;
  minPostIntervalMs: number;
  historyTail: number;
}

export function createWebUiState(): WebUiState {
  return {
    server: null,
    starting: null,
    url: "",
    host: process.env.MMA_WEBUI_HOST || "127.0.0.1",
    token: process.env.MMA_WEBUI_TOKEN || null,
    clients: new Set(),
    bridge: null,
    busy: false,
    lastPostTs: 0,
    minPostIntervalMs: 500,
    historyTail: 200,
  };
}

export interface SseEvent { type: string; ts: number; [k: string]: unknown; }

export function broadcast(ev: SseEvent, s: WebUiState): void {
  const payload = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const client of s.clients) {
    try { client.write(payload); } catch { s.clients.delete(client); }
  }
}
```

(Global `state` singleton can be added later; tests use `createWebUiState()`.)

- [ ] **Step 4: Create `src/modules/webui/server.ts`**

```ts
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { exec } from "node:child_process";
import { broadcast, type WebUiAssets, type WebUiState } from "./state";

const MAX_CLIENTS = Number(process.env.MMA_WEBUI_MAX_CLIENTS) || 5;
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 32 * 1024;

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function checkAuth(req: IncomingMessage, reqUrl: URL, s: WebUiState): boolean {
  if (!s.token) return true;
  const header = req.headers["x-mma-token"];
  if (typeof header === "string" && header === s.token) return true;
  return reqUrl.searchParams.get("token") === s.token;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, cap = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > cap) { reject(Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sameOrigin(req: IncomingMessage, reqUrl: URL): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(String(origin)).host === reqUrl.host; } catch { return false; }
}

export function handleRequest(req: IncomingMessage, res: ServerResponse, assets: WebUiAssets, s: WebUiState): void {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || s.host}`);

  if (reqUrl.pathname === "/events") {
    if (s.clients.size >= MAX_CLIENTS) { sendJson(res, 503, { error: "too many clients" }); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("retry: 1200\n\n");
    res.write(`event: state\ndata: ${JSON.stringify({ busy: s.busy })}\n\n`);
    s.clients.add(res);
    const hb = setInterval(() => { try { res.write(`: hb ${Date.now()}\n\n`); } catch { clearInterval(hb); } }, 15_000);
    req.on("close", () => { clearInterval(hb); s.clients.delete(res); });
    return;
  }

  if (reqUrl.pathname === "/" || reqUrl.pathname === "/index.html") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(assets.html); return; }
  if (reqUrl.pathname === "/styles.css") { res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" }); res.end(assets.css); return; }
  if (reqUrl.pathname === "/app.js") { res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); res.end(assets.js); return; }

  if (reqUrl.pathname.startsWith("/api/")) {
    if (!checkAuth(req, reqUrl, s)) { sendJson(res, 401, { error: "unauthorized" }); return; }
    if (!sameOrigin(req, reqUrl)) { sendJson(res, 403, { error: "cross-origin not allowed" }); return; }

    if (reqUrl.pathname === "/api/state" && req.method === "GET") {
      sendJson(res, 200, { busy: s.busy, state: s.bridge?.getState?.() ?? null });
      return;
    }

    if (reqUrl.pathname === "/api/message" && req.method === "POST") {
      if (!s.bridge) { sendJson(res, 503, { error: "no_bridge" }); return; }
      if (s.busy || s.bridge.isBusy()) { sendJson(res, 409, { error: "busy" }); return; }
      if (Date.now() - s.lastPostTs < s.minPostIntervalMs) { sendJson(res, 429, { error: "rate_limited" }); return; }
      readBody(req).then((raw) => JSON.parse(raw)).then((body: { text?: string; images?: string[] }) => {
        const text = String(body.text ?? "").slice(0, MAX_MESSAGE_CHARS).trim();
        if (!text && !(body.images?.length)) { sendJson(res, 400, { error: "empty" }); return; }
        s.lastPostTs = Date.now(); s.busy = true;
        broadcast({ type: "state", ts: Date.now(), busy: true }, s);
        s.bridge?.submit(text, { images: body.images }).catch((err: Error) => {
          s.busy = false;
          broadcast({ type: "turn_end", ts: Date.now(), success: false, error: err?.message || String(err) }, s);
        });
        sendJson(res, 202, { ok: true });
      }).catch((err: NodeJS.ErrnoException) => {
        sendJson(res, err?.code === "BODY_TOO_LARGE" ? 413 : 400, { error: err?.code === "BODY_TOO_LARGE" ? "body too large" : "invalid JSON" });
      });
      return;
    }

    if (reqUrl.pathname === "/api/interrupt" && req.method === "POST") {
      if (!s.busy && !s.bridge?.isBusy()) { sendJson(res, 409, { error: "idle" }); return; }
      s.busy = false; s.bridge?.interrupt(); sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "not found" });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found");
}

export function startServer(assets: WebUiAssets, s: WebUiState): Promise<string> {
  if (s.server) return Promise.resolve(s.url);
  if (s.starting) return s.starting;
  if (!isLoopback(s.host) && !s.token) {
    return Promise.reject(new Error(`refusing to bind ${s.host} without token (non-loopback)`));
  }
  const desired = Number(process.env.MMA_WEBUI_PORT) || 0;
  s.starting = new Promise<string>((resolve, reject) => {
    const srv = createServer((req, res) => handleRequest(req, res, assets, s));
    srv.on("error", (err) => { s.starting = null; reject(err); });
    srv.listen(desired, s.host, () => {
      s.server = srv as Server;
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : desired;
      s.url = `http://${s.host}:${port}`;
      s.starting = null; resolve(s.url);
    });
  });
  return s.starting;
}

export function stopServer(s?: WebUiState): void {
  if (!s) return;
  for (const c of s.clients) { try { c.end(); } catch {} }
  s.clients.clear();
  if (s.server) { try { s.server.close(); } catch {} s.server = null; }
  s.starting = null; s.busy = false;
}

export function tryOpenBrowser(url: string): void {
  if (process.env.MMA_WEBUI_OPEN === "0") return;
  try {
    const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
    const child = exec(cmd, { windowsHide: true }); child.unref?.();
  } catch { /* best-effort */ }
}
```

Note: `stopServer()` with no arg is used by tests for the module-global; export a global state accessor in Step 3 if you prefer — otherwise tests call `stopServer(s)`.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/webui-server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/modules/webui/state.ts src/modules/webui/server.ts tests/webui-server.test.ts
git commit -m "feat(webui): HTTP/SSE/REST server module (app≠listen)"
```

---

### Task 6: SSE event forwarding from the agent loop

**Files:**
- Create: `src/modules/webui/forward.ts`
- Test: `tests/webui-forward.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/webui-forward.test.ts
import { describe, it, expect } from "vitest";
import { createWebUiState } from "../src/modules/webui/state";
import { makeForwarder } from "../src/modules/webui/forward";

describe("webui forwarder", () => {
  it("coalesces text chunks and emits on flush", () => {
    const s = createWebUiState();
    const seen: string[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev.type), { flushMs: 5 });
    fwd.onText("a"); fwd.onText("b");
    fwd.flushNow();
    expect(seen).toContain("text");
  });

  it("maps tool start/end to events", () => {
    const s = createWebUiState();
    const seen: string[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev.type));
    fwd.onToolStart({ id: "1", name: "read_file", arguments: { path: "x" } });
    fwd.onToolEnd({ id: "1", name: "read_file", arguments: { path: "x" } }, { success: true, output: "ok" }, 12);
    expect(seen).toEqual(["tool_start", "tool_end"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/webui-forward.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/modules/webui/forward.ts`**

```ts
import { broadcast, type SseEvent, type WebUiState } from "./state";

interface ToolCallLike { id: string; name: string; arguments: Record<string, unknown>; }
interface ToolResultLike { success: boolean; output: string; }

export interface Forwarder {
  onText(chunk: string): void;
  onMeta(chunk: string): void;
  onPhase(phase: string): void;
  onToolStart(call: ToolCallLike): void;
  onToolEnd(call: ToolCallLike, result: ToolResultLike, durationMs: number): void;
  onTurnEnd(summary: { success: boolean; durationMs?: number; toolCalls?: number; interrupted?: boolean }): void;
  flushNow(): void;
}

export function makeForwarder(
  s: WebUiState,
  sink: (ev: SseEvent) => void = (ev) => broadcast(ev, s),
  opts: { flushMs?: number } = {},
): Forwarder {
  const flushMs = opts.flushMs ?? 350;
  let buf = { text: "", meta: "" };
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (buf.text) { sink({ type: "text", ts: Date.now(), chunk: buf.text }); buf.text = ""; }
    if (buf.meta) { sink({ type: "meta", ts: Date.now(), chunk: buf.meta }); buf.meta = ""; }
  };
  const schedule = () => { if (!timer) timer = setTimeout(flush, flushMs); };

  return {
    onText(chunk) { buf.text += chunk; schedule(); },
    onMeta(chunk) { buf.meta += chunk; schedule(); },
    onPhase(phase) { flush(); sink({ type: "phase", ts: Date.now(), phase }); },
    onToolStart(call) { flush(); sink({ type: "tool_start", ts: Date.now(), toolCallId: call.id, name: call.name, args: call.arguments }); },
    onToolEnd(call, result, durationMs) {
      flush();
      sink({ type: "tool_end", ts: Date.now(), toolCallId: call.id, name: call.name, success: result.success, durationMs });
    },
    onTurnEnd(summary) { flush(); s.busy = false; sink({ type: "turn_end", ts: Date.now(), ...summary }); },
    flushNow: flush,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/webui-forward.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/webui/forward.ts tests/webui-forward.test.ts
git commit -m "feat(webui): agent-loop → SSE forwarder with coalescing"
```

---

### Task 7: `WebHost` (implements `Host`)

**Files:**
- Create: `src/core/web-host.ts`
- Test: `tests/web-host.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/web-host.test.ts
import { describe, it, expect } from "vitest";
import { WebHost } from "../src/core/web-host";

describe("WebHost", () => {
  it("delegates submit to runAgent and guards busy", async () => {
    let busy = false; const ran: string[] = [];
    const host = new WebHost({
      runAgent: async (t) => { ran.push(t); return "ok"; },
      isBusy: () => busy,
      interrupt: () => { busy = false; },
      executeCommand: async () => {},
      getState: () => ({ busy }),
    });
    expect(await host.submit("hi")).toBe("ok");
    expect(ran).toEqual(["hi"]);
    busy = true;
    await expect(host.submit("again")).rejects.toThrow("agent is busy");
  });

  it("executeCommand ignores non-slash input", async () => {
    let called = 0;
    const host = new WebHost({
      runAgent: async () => "x", isBusy: () => false, interrupt: () => {},
      executeCommand: async () => { called++; }, getState: () => ({ busy: false }),
    });
    await host.executeCommand("hello");
    expect(called).toBe(0);
    await host.executeCommand("/status");
    expect(called).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/web-host.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/core/web-host.ts`**

```ts
import type { Host, HostStateSnapshot } from "../core/host";
import type { HostBridgeSubmitOptions } from "../modules/types";
import type { OutputEvent } from "../output/types";
import { defaultOutputBus } from "../output/bus";

export interface WebHostDeps {
  runAgent: (text: string) => Promise<unknown>;
  isBusy: () => boolean;
  interrupt: () => void;
  executeCommand: (line: string) => Promise<void>;
  getState: () => HostStateSnapshot;
  addPendingImage?: (dataUrl: string) => void;
}

/** Host implementation for `mma web` — no TTY, no LineEditor. */
export class WebHost implements Host {
  constructor(private deps: WebHostDeps) {}

  isBusy(): boolean { return this.deps.isBusy(); }

  async submit(text: string, o?: HostBridgeSubmitOptions): Promise<unknown> {
    if (this.deps.isBusy()) throw new Error("agent is busy");
    for (const url of o?.images ?? []) this.deps.addPendingImage?.(url);
    return this.deps.runAgent(text);
  }

  interrupt(): void { if (this.deps.isBusy()) this.deps.interrupt(); }

  subscribeOutput(fn: (ev: OutputEvent) => void): () => void {
    return defaultOutputBus.subscribe(fn);
  }

  async executeCommand(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/")) return;
    await this.deps.executeCommand(trimmed);
  }

  getState(): HostStateSnapshot { return this.deps.getState(); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/web-host.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/web-host.ts tests/web-host.test.ts
git commit -m "feat(web-host): Host implementation for mma web"
```

---

### Task 8: Static chat assets (STYLE.md-aligned)

**Files:**
- Create: `src/modules/webui/assets/index.html`, `styles.css`, `app.js`
- Create: `src/modules/webui/assets.ts` (read files verbatim)
- Test: `tests/webui-assets.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/webui-assets.test.ts
import { describe, it, expect } from "vitest";
import { loadAssets } from "../src/modules/webui/assets";

describe("webui assets", () => {
  it("loads html/css/js from disk", () => {
    const a = loadAssets();
    expect(a.html).toContain("<!DOCTYPE html>");
    expect(a.css.length).toBeGreaterThan(10);
    expect(a.js).toContain("EventSource");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/webui-assets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the assets**

`src/modules/webui/assets/index.html` — minimal chat shell mirroring the mockup topbar + feed + input:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MMA Web</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="bar-top">
    <button class="btn primary" id="newChat">+ new chat</button>
    <span class="model-name" id="modelName"></span>
    <span id="sessionName" class="dim"></span>
  </header>
  <main class="layout">
    <section class="chat">
      <div class="msgs" id="msgs"></div>
      <div class="input-area">
        <textarea class="inp" id="inp" rows="2" placeholder="message… (/ for commands)"></textarea>
        <div class="inp-meta"><span>Enter — send</span><span>Shift+Enter — newline</span><span>Esc — stop</span></div>
      </div>
    </section>
    <aside class="sb">
      <div class="sec-h">▾ plan</div>
      <div id="plan" class="sec-body"></div>
      <div class="sec-h">▾ session</div>
      <div id="usage" class="sec-body"></div>
    </aside>
  </main>
  <script src="/app.js"></script>
</body>
</html>
```

`src/modules/webui/assets/styles.css` — CSS variables + dark/light + STYLE.md glyph colors:

```css
:root{--bg:#0a0c10;--panel:#0d1117;--text:#c9d1d9;--dim:#6e7681;--faint:#484f58;--accent:#58a6ff;--user:#79c0ff;--user-bg:#111a26;--ok:#3fb950;--warn:#d29922;--err:#ff7b72;--think:#8b7bb8;--border:#161b22}
body.light{--bg:#f6f8fa;--panel:#fff;--text:#1f2328;--dim:#57606a;--faint:#8c959f;--accent:#0969da;--user:#0550ae;--user-bg:#ddf4ff;--ok:#1a7f37;--warn:#9a6700;--err:#cf222e;--think:#8c959f;--border:#d0d7de}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:13px/1.5 ui-monospace,"Cascadia Code",Consolas,monospace;height:100vh;display:flex;flex-direction:column;overflow:hidden}
.bar-top{display:flex;gap:14px;align-items:center;padding:8px 14px;background:var(--panel);border-bottom:1px solid var(--border);color:var(--dim);font-size:12.5px}
.btn{cursor:pointer;color:var(--dim);padding:3px 9px;border:none;background:none;font:inherit;border-radius:4px}
.btn:hover{color:var(--text);background:var(--border)}
.btn.primary{color:var(--accent)} .model-name{color:var(--think)} .dim{color:var(--dim)}
.layout{flex:1;display:flex;min-height:0}
.chat{flex:1;display:flex;flex-direction:column;min-width:0}
.msgs{flex:1;overflow-y:auto;padding:18px 22px;display:flex;flex-direction:column;gap:11px}
.msgs>*{flex-shrink:0}
.u{color:var(--user);background:var(--user-bg);border-left:2px solid var(--accent);padding:7px 12px;border-radius:0 4px 4px 0}
.u::before{content:"> "}
.ans{color:var(--text)}
.think-h{color:var(--think);cursor:pointer;font-size:12.5px}
.think-body{color:var(--faint);padding-left:18px;white-space:pre-wrap;font-size:12.5px}
.act{display:flex;gap:8px}.act .g,.act .lab{color:var(--accent)}.act .args,.act .sep{color:var(--dim)}.act .ok{color:var(--ok)}
.metric,.detail{color:var(--dim)} .detail{padding-left:26px}
.err{color:var(--err)} .warn{color:var(--warn)}
.busy{color:var(--think)}
.input-area{margin:14px 22px 16px}
.inp{width:100%;padding:12px 14px;resize:none;display:block;background:var(--panel);border:1px solid var(--border);border-radius:6px;color:var(--text);font:inherit;font-size:13.5px;outline:none;min-height:46px}
.inp:focus{border-color:var(--ok)} .inp::placeholder{color:var(--dim)}
.inp-meta{display:flex;gap:14px;margin-top:6px;color:var(--faint);font-size:11.5px}
.sb{width:280px;min-width:280px;border-left:1px solid var(--border);background:var(--panel);padding:12px 16px;overflow-y:auto}
.sec-h{color:var(--dim);font-size:12.5px;margin:8px 0 6px}
.kv{display:flex;justify-content:space-between;color:var(--dim);padding:2px 0}.kv b{font-weight:400;color:var(--text)}
.plan-step{padding:3px 0 3px 16px;color:var(--dim)}.plan-step.done{color:var(--ok)}.plan-step.cur{color:var(--accent)}
::-webkit-scrollbar{width:8px}::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
```

`src/modules/webui/assets/app.js` — SSE client + rendering + input:

```js
(() => {
  const msgs = document.getElementById("msgs");
  const inp = document.getElementById("inp");
  const planEl = document.getElementById("plan");
  const usageEl = document.getElementById("usage");
  const modelEl = document.getElementById("modelName");
  const sessionEl = document.getElementById("sessionName");
  let cur = null; // current assistant text node

  function line(cls, text) {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  const es = new EventSource("/events");
  es.addEventListener("text", (e) => {
    const { chunk } = JSON.parse(e.data);
    if (!cur) cur = line("ans", "");
    cur.textContent += chunk;
    msgs.scrollTop = msgs.scrollHeight;
  });
  es.addEventListener("meta", (e) => {
    const { chunk } = JSON.parse(e.data);
    const h = msgs.querySelector(".think-body:last-of-type");
    if (!h) line("think-body", chunk); else h.textContent += chunk;
  });
  es.addEventListener("phase", (e) => {
    const { phase } = JSON.parse(e.data);
    if (phase === "thinking") line("busy", "✦ thinking…");
  });
  es.addEventListener("tool_start", (e) => {
    const { name, args } = JSON.parse(e.data);
    line("act", `◇ ${name} · ${JSON.stringify(args).slice(0, 120)}`);
  });
  es.addEventListener("tool_end", (e) => {
    const { name, success, durationMs } = JSON.parse(e.data);
    line("detail", `↳ ${name} ${success ? "✓" : "✗"} ${durationMs}ms`);
  });
  es.addEventListener("turn_end", () => { cur = null; });
  es.addEventListener("state", (e) => {
    const { busy } = JSON.parse(e.data);
    inp.disabled = busy;
  });

  async function refresh() {
    try {
      const r = await fetch("/api/state").then((x) => x.json());
      const st = r.state || {};
      modelEl.textContent = st.model ? `${st.model} · ${st.provider || ""}` : "";
      sessionEl.textContent = st.sessionId ? `session ${st.sessionId}` : "";
      usageEl.innerHTML = "";
      for (const [k, v] of Object.entries({
        context: st.contextUsed != null ? `${st.contextUsed} / ${st.contextLimit}` : "—",
        compactions: st.compactionCount ?? 0,
        cost: st.costUsd != null ? `${st.costUsd}¢` : "—",
      })) {
        const d = document.createElement("div");
        d.className = "kv";
        d.innerHTML = `<span>${k}</span><b>${v}</b>`;
        usageEl.appendChild(d);
      }
      planEl.innerHTML = "";
      if (st.plan) {
        st.plan.steps.forEach((s, i) => {
          const d = document.createElement("div");
          const cur2 = i === st.plan.currentIndex;
          d.className = "plan-step " + (s.status === "done" ? "done" : cur2 ? "cur" : "");
          d.textContent = (s.status === "done" ? "✓ " : cur2 ? "▸ " : "○ ") + s.text;
          planEl.appendChild(d);
        });
      }
    } catch { /* server down */ }
  }
  setInterval(refresh, 2000);
  refresh();

  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = inp.value.trim();
      if (!text) return;
      if (text.startsWith("/")) {
        line("u", text);
        fetch("/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ line: text }) });
        inp.value = "";
        return;
      }
      line("u", text);
      cur = null;
      fetch("/api/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      inp.value = "";
    }
    if (e.key === "Escape") {
      fetch("/api/interrupt", { method: "POST" });
    }
  });

  document.getElementById("newChat").addEventListener("click", () => { msgs.innerHTML = ""; cur = null; });
})();
```

`src/modules/webui/assets.ts`:

```ts
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { WebUiAssets } from "./state";

const here = dirname(fileURLToPath(import.meta.url));

export function loadAssets(): WebUiAssets {
  const read = (name: string, fallback: string) => {
    const p = join(here, "assets", name);
    return existsSync(p) ? readFileSync(p, "utf8") : fallback;
  };
  return {
    html: read("index.html", "<!DOCTYPE html><h1>MMA web assets missing</h1>"),
    css: read("styles.css", "/* missing */"),
    js: read("app.js", "// missing"),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/webui-assets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/webui/assets.ts src/modules/webui/assets tests/webui-assets.test.ts
git commit -m "feat(webui): static chat assets aligned with STYLE.md"
```

---

### Task 9: Wire `WebUiModule` and register `mma web`

**Files:**
- Create: `src/modules/webui/module.ts`
- Create: `src/cli/web-command.ts`
- Modify: `src/cli/commands.ts` (register subcommand), `src/cli/main.ts` (dispatch)

- [ ] **Step 1: Create `src/modules/webui/module.ts`**

```ts
import type { Host } from "../../core/host";
import { createWebUiState, type WebUiState } from "./state";
import { loadAssets } from "./assets";
import { startServer, stopServer, tryOpenBrowser } from "./server";
import { makeForwarder, type Forwarder } from "./forward";

export interface WebUiHandle {
  state: WebUiState;
  forwarder: Forwarder;
  url: Promise<string>;
  attachHost(host: Host): void;
  stop(): void;
}

export async function startWebUi(host: Host): Promise<WebUiHandle> {
  const state = createWebUiState();
  state.bridge = host;
  const forwarder = makeForwarder(state);
  const url = startServer(loadAssets(), state);
  return {
    state,
    forwarder,
    url,
    attachHost(h: Host) { state.bridge = h; },
    stop() { stopServer(state); },
  };
}

export { tryOpenBrowser };
```

- [ ] **Step 2: Create `src/cli/web-command.ts`**

```ts
import { bootstrap } from "../core/bootstrap";
import { WebHost } from "./web-host";
import { planSnapshotFromModule } from "../core/host-plan";
import { startWebUi, tryOpenBrowser } from "../modules/webui/module";
import { createHostBridge } from "../core/host";
import { getDefaultChannel } from "../output/channel";
import { t } from "../i18n";
import { pc } from "../ui/colors";

export interface WebCommandOptions {
  port?: number;
  host?: string;
  token?: string;
  noOpen?: boolean;
  projectDir?: string;
}

/** `mma web` — bootstrap without a TTY REPL, serve the browser chat, block. */
export async function runWeb(opts: WebCommandOptions): Promise<void> {
  if (opts.port) process.env.MMA_WEBUI_PORT = String(opts.port);
  if (opts.host) process.env.MMA_WEBUI_HOST = opts.host;
  if (opts.token) process.env.MMA_WEBUI_TOKEN = opts.token;
  if (opts.noOpen) process.env.MMA_WEBUI_OPEN = "0";

  getDefaultChannel().setQuiet(true);

  const { agent, config, execModule } = await bootstrap(
    undefined,
    opts.projectDir,
    undefined,
    true, // exitOnComplete — no interactive prompt owns stdin
  );

  const host = new WebHost({
    runAgent: (text) => agent.run(text),
    isBusy: () => false, // replaced by single-flight below
    interrupt: () => agent.shutdown(),
    executeCommand: async (line) => { /* Phase 3 wires the command map */ },
    getState: () => ({
      busy: false,
      model: config.model,
      provider: config.provider?.active,
      plan: planSnapshotFromModule(execModule.getActivePlan() as never),
    }),
  });

  const web = await startWebUi(host);
  const url = await web.url;
  getDefaultChannel().writeLine(pc.dim(`  ${t("cli.web_started", { url })}`));
  if (!opts.noOpen) tryOpenBrowser(url);

  // Keep the process alive until interrupted (Ctrl+C).
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => { web.stop(); agent.shutdown(); resolve(); });
    process.on("SIGTERM", () => { web.stop(); agent.shutdown(); resolve(); });
  });
}
```

Note: single-flight busy tracking is Phase 2.x — the server's own `state.busy` guard already prevents concurrent submits; `isBusy: () => false` is acceptable for the first cut, but prefer wiring `state.busy` back. Adjust `WebHost` deps to `isBusy: () => web.state.busy` once `web` exists (reorder: create host lazily or pass a mutable ref).

- [ ] **Step 3: Register the subcommand in `src/cli/commands.ts`**

Add near other top-level commands (after `session`):

```ts
  program
    .command("web")
    .description(t("cli.web.description"))
    .option("-p, --port <n>", t("cli.web.port"))
    .option("--host <addr>", t("cli.web.host"))
    .option("--token <t>", t("cli.web.token"))
    .option("--no-open", t("cli.web.no_open"))
    .action(() => {
      /* handled by main.ts after parse */
    });
```

- [ ] **Step 4: Dispatch in `src/cli/main.ts`**

After `program.parse(process.argv)` and before the one-shot branch, add:

```ts
  if (process.argv[2] === "web") {
    const { runWeb } = await import("./web-command");
    const o = program.opts();
    await runWeb({
      port: o.port ? Number(o.port) : undefined,
      host: o.host,
      token: o.token,
      noOpen: o.open === false,
      projectDir,
    });
    return;
  }
```

(Match how existing subcommands detect their name — reuse the same mechanism; the check must run before `program.args.length > 0` handling.)

- [ ] **Step 5: Add i18n keys**

`src/i18n/en.json`:
```json
"cli.web.description": "Run the agent with a browser UI",
"cli.web.port": "fixed port (default: random)",
"cli.web.host": "bind address (default: 127.0.0.1)",
"cli.web.token": "require this token (mandatory for non-loopback)",
"cli.web.no_open": "do not open the browser automatically",
"cli.web_started": "web ui → {url}"
```

`src/i18n/ru.json`:
```json
"cli.web.description": "Запустить агента с браузерным интерфейсом",
"cli.web.port": "фиксированный порт (по умолчанию случайный)",
"cli.web.host": "адрес привязки (по умолчанию 127.0.0.1)",
"cli.web.token": "требовать этот токен (обязателен для не-loopback)",
"cli.web.no_open": "не открывать браузер автоматически",
"cli.web_started": "web ui → {url}"
```

- [ ] **Step 6: Manual smoke**

Run: `bun run mma web --no-open --port 3799`
Expected: prints `web ui → http://127.0.0.1:3799`; `curl http://127.0.0.1:3799/` returns the page; Ctrl+C stops it.

- [ ] **Step 7: Typecheck + full suite**

Run: `bun test && tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/webui/module.ts src/cli/web-command.ts src/cli/commands.ts src/cli/main.ts src/i18n/en.json src/i18n/ru.json
git commit -m "feat(web): mma web subcommand serving browser chat"
```

---

### Task 10: Auth + limits tests

**Files:**
- Test: `tests/webui-auth.test.ts`

- [ ] **Step 1: Write the tests**

```ts
// tests/webui-auth.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { handleRequest } from "../src/modules/webui/server";
import { createWebUiState } from "../src/modules/webui/state";

const assets = { html: "x", css: "y", js: "z" };

async function listen(s: ReturnType<typeof createWebUiState>) {
  const srv = createServer((req, res) => handleRequest(req, res, assets, s));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const a = srv.address(); const port = typeof a === "object" && a ? a.port : 0;
  return { base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

describe("webui auth", () => {
  it("401 without token when token set", async () => {
    const s = createWebUiState(); s.token = "secret";
    const { base, close } = await listen(s);
    expect((await fetch(base + "/api/state")).status).toBe(401);
    expect((await fetch(base + "/api/state", { headers: { "x-mma-token": "secret" } })).status).toBe(200);
    close();
  });

  it("403 on cross-origin POST", async () => {
    const s = createWebUiState();
    const { base, close } = await listen(s);
    const r = await fetch(base + "/api/message", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://evil.test" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(403);
    close();
  });

  it("409 when no bridge", async () => {
    const s = createWebUiState();
    const { base, close } = await listen(s);
    const r = await fetch(base + "/api/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    expect(r.status).toBe(503);
    close();
  });
});
```

- [ ] **Step 2: Run**

Run: `bun test tests/webui-auth.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/webui-auth.test.ts
git commit -m "test(webui): auth, CSRF and bridge guards"
```

---

### Task 11: Docs + changelog

**Files:**
- Modify: `docs/agents/modules.md`, `docs/agents/architecture.md`, `AGENTS.md`, `CHANGELOG.md`

- [ ] **Step 1: Document the mode**

- `docs/agents/modules.md`: add a "Web mode (`mma web`)" subsection — subcommand flags, env vars (`MMA_WEBUI_PORT/HOST/TOKEN/OPEN/MAX_CLIENTS`), SSE/REST endpoints, relation to the `examples/plugins/web-ui` plugin.
- `docs/agents/architecture.md`: add the `Host` seam to the module map (Repl and WebHost as two implementations) and reference rule #13 (app≠listen).
- `AGENTS.md`: add a "Browser mode (`mma web`)" section with the one-line run command and the spec link.

- [ ] **Step 2: Changelog**

Add to `CHANGELOG.md` under a new version (MINOR):

```md
## [X.Y.0] - 2026-09-23
### Added
- **web mode**: `mma web [--port] [--host] [--token] [--no-open]` — browser chat (SSE + REST) without a TTY.
- **host seam**: shared `Host` interface; `Repl` and `WebHost` are two implementations over one agent.
```

- [ ] **Step 3: Commit**

```bash
git add docs/agents/modules.md docs/agents/architecture.md AGENTS.md CHANGELOG.md
git commit -m "docs: document mma web mode"
```

---

### Task 12: Verify end-to-end

- [ ] **Step 1: Full gates**

Run: `bun test && tsc --noEmit`
Expected: PASS.

- [ ] **Step 2: Manual cert**

Run: `bun run mma web --port 3799`
Then in a second shell:
```bash
curl -s http://127.0.0.1:3799/api/state
curl -s -X POST http://127.0.0.1:3799/api/message -H "content-type: application/json" -d '{"text":"say hi"}'
curl -s -N http://127.0.0.1:3799/events   # observe text/tool/phase/turn_end
```
Expected: state JSON, `{ok:true}`, and an SSE stream with the assistant reply.

- [ ] **Step 3: Browser check**

Open `http://127.0.0.1:3799/` — send a message, see streaming text, tool lines, plan/session in the sidebar, Enter/Esc behavior. Compare against `mockups/layout-v6.html`.

- [ ] **Step 4: Final commit (if any fixes)**

```bash
git add -A && git commit -m "fix(web): end-to-end smoke fixes"
```

---

## Later phases (separate plans)

3. **Sidebar + selectors + session tabs** — model/provider/context dropdowns over `/api/config`; plan/usage/sessions panes; **browser-like session tabs** (topbar `+`/`⚙`/`☰` icon buttons, open/switch/close tabs, pick session from `☰`); session switching.
4. **Settings modal** — registry-driven panel (`/api/config` GET/POST), theme, memory/skills/plugins pages.
5. **Interactive reasoning + questions** — collapse toggles; web `PromptIO` (`question`/`approve` behind the seam).
6. **Polish** — esbuild bundling of frontend TS, i18n dict served to the page, reconnect/resync, Playwright smoke, cert scenario.

## Self-review notes

- **Spec coverage:** Host seam (spec §Architecture) → Tasks 1–4. `mma web` + SSE/REST (spec §Wire contract) → Tasks 5–9. Auth (spec §Security) → Task 10. Static frontend (spec §Frontend) → Task 8 (bundling deferred to Phase 6, noted). Docs/changelog → Task 11. Phasing matches spec §Implementation phasing.
- **Deferred by design:** `executeCommand` in `WebHost` is a no-op in Task 9; the real command map is Phase 3 (spec lists commands under a later phase). Flagged inline, not a placeholder.
- **Type consistency:** `HostStateSnapshot`, `WebUiState`, `Forwarder`, `WebUiAssets` names are used identically across tasks; `planSnapshotFromModule` signature stable between Tasks 3 and 9.
