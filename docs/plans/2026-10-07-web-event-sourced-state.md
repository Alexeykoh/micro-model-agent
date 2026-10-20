# Web Event-Sourced State — Implementation Plan

> **Статус:** исполнено (2026-10-20) — event-sourced состояние web реализовано в master:
> `pushState` + SSE-событие `state`/`sessions`, чистый клиентский роутинг
> (`assets/js/state-sync.ts`). Чекбоксы проставлены по факту.

**Goal:** Снапшот состояния сессии едет внутри SSE-события `state`; клиент хранит снапшот на вкладке, таймеры-поллы удаляются.

**Architecture:** Один серверный хелпер `pushState(s, sessionId)` рассылает полный `HostStateSnapshot` по SSE. Клиент роутит событие в `tab.state` через чистый модуль `state-sync.ts`; REST `/api/state` остаётся для boot/reconnect/ensure.

**Tech Stack:** Bun + TS, vitest, happy-dom.

**Spec:** [docs/specs/2026-10-07-web-event-sourced-state-design.md](../specs/2026-10-07-web-event-sourced-state-design.md)

---

## File structure

- **Modify** `src/modules/webui/session/session-status.ts` — add `pushState`.
- **Modify** `src/modules/webui/session/turns.ts` — 7 call sites → `pushState`.
- **Modify** `src/modules/webui/session/run-agent.ts` — turn-end → `pushState`.
- **Modify** `src/modules/webui/module.ts` — re-index → `pushState`.
- **Modify** `src/modules/webui/settings/reconfigure.ts` — → `pushState`.
- **Modify** `src/modules/webui/session/sessions-api.ts` — emit `sessions` event.
- **Create** `src/modules/webui/assets/js/state-sync.ts` — pure routing.
- **Modify** `src/modules/webui/assets/app.ts` — `applyState`/`renderActiveState`/`ensureTabState`, drop timers.
- **Modify** `src/modules/webui/assets/js/session/tabs.ts` — hooks wiring.
- **Modify** `src/modules/webui/assets/js/core/store/index.ts` — hooks types.
- **Modify** `src/modules/webui/assets/js/core/store/session.ts` — `host` doc.
- **Tests:** create `tests/webui-push-state.test.ts`, `tests/webui-state-sync.test.ts`; update `tests/webui-assets.test.ts`, `tests/webui-usage.test.ts`.

---

## Task 1: Server `pushState`

**Files:**
- Modify: `src/modules/webui/session/session-status.ts`
- Test: `tests/webui-push-state.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import type { ServerResponse } from "node:http";
import { createWebUiState } from "../src/modules/webui/state";
import { pushState } from "../src/modules/webui/session/session-status";

function capture(): { chunks: string[]; res: ServerResponse } {
  const chunks: string[] = [];
  return {
    chunks,
    res: { write: (c: string) => (chunks.push(c), true), end: () => {} } as unknown as ServerResponse,
  };
}

describe("pushState", () => {
  it("broadcasts a full snapshot stamped with the session id", () => {
    const s = createWebUiState();
    const { chunks, res } = capture();
    s.clients.add(res);
    s.bridge = { getState: (id?: string) => ({ sessionId: id, contextUsed: 42 }) } as never;

    pushState(s, "S");
    const out = chunks.join("");
    expect(out).toContain("event: state");
    expect(out).toContain('"sessionId":"S"');
    expect(out).toContain('"contextUsed":42');
    expect(out).toContain('"state":{');
  });

  it("sends a global (sessionless) snapshot without a sessionId", () => {
    const s = createWebUiState();
    const { chunks, res } = capture();
    s.clients.add(res);
    s.bridge = { getState: () => ({ sessionId: undefined }) } as never;
    pushState(s);
    expect(chunks.join("")).not.toContain('"sessionId":"S"');
  });
});
```

- [x] **Step 2: Run test, verify fail** — `bun test tests/webui-push-state.test.ts` → `pushState is not a function`.

- [x] **Step 3: Implement**

Add to `session-status.ts` (import `broadcast` + `SseTransport` alclasses from `../state`):

```ts
/**
 * Рассылает полный снапшот сессии SSE-событием `state` — единственная форма
 * апдейта сайдбара. `sessionId` штампуется, чтобы клиент положил снапшот во
 * вкладку-владельца (без него — активная/глобальная проекция).
 */
export function pushState(s: RuntimeState & SseTransport, sessionId?: string | null): void {
  broadcast(
    {
      type: "state",
      ts: Date.now(),
      ...sessionStatus(s),
      ...(sessionId ? { sessionId } : {}),
      state: s.bridge?.getState?.(sessionId ?? undefined) ?? null,
    },
    s,
  );
}
```

- [x] **Step 4: Run test, verify pass** — `bun test tests/webui-push-state.test.ts`.
- [x] **Step 5: Commit** — `git add tests/webui-push-state.test.ts src/modules/webui/session/session-status.ts && git commit -m "feat(webui): pushState sends full session snapshot over SSE"`.

---

## Task 2: Replace `state` broadcast call sites

**Files:** `turns.ts`, `run-agent.ts`, `module.ts`, `reconfigure.ts`; update `tests/webui-usage.test.ts`.

- [x] **Step 1:** In `session/turns.ts` replace every
  `broadcast({ type: "state", ts: Date.now(), ...sessionStatus(s) }, s);` with `pushState(s, <id>)`:
  - line 73 (startTurn catch) → `pushState(s, target)`
  - line 114 (runRunnerTurn start) → `pushState(s, sessionId)`
  - line 120 (runRunnerTurn catch) → `pushState(s, sessionId)`
  - line 133 (finishTurn release) → `pushState(s, id)`
  - line 141 (finishTurn reserve) → `pushState(s, id)`
  - line 210 (dispatchPost queue) → `pushState(s, target)`
  - line 220 (dispatchPost reserve) → `pushState(s, target)`
  Import `pushState` from `./session-status`; drop now-unused `sessionStatus` import (keep `syncBusy`/`reserveBusy`/`releaseBusy`).

- [x] **Step 2:** In `session/run-agent.ts` replace the `broadcast({ type: "state", ... usage, usageSessionId: owner }, state)` block (lines ~159-162) with `pushState(state, owner);`. Import `pushState` from `./session-status`; drop `sessionStatus` import; keep `broadcast` (used by live `usage`).

- [x] **Step 3:** In `module.ts` line 172 replace `broadcast({ type: "state", ...sessionStatus(state), usage: state.usage }, state);` with `pushState(state);`. Import `pushState`; drop `sessionStatus` import.

- [x] **Step 4:** In `settings/reconfigure.ts` line 53 replace with `pushState(state);`. Drop `sessionStatus` and `broadcast` imports; import `pushState`.

- [x] **Step 5: Update `tests/webui-usage.test.ts`** `makeReconfigure refreshes the sidebar context limit` (line ~131): give the state a bridge so `pushState` has a snapshot to serialize:

```ts
s.bridge = {
  getState: () => buildHostState({ config: DEFAULTS, usage: s.usage }, false),
} as never;
```

(Keep `s.usage` seeding as-is; assertion `writes.join("")).toContain('"contextLimit":86016')` stays.)

- [x] **Step 6: Run** — `bun test tests/webui-usage.test.ts tests/webui-reconfigure.test.ts tests/webui-sse-routing.test.ts tests/webui-live-usage.test.ts` → PASS.

- [x] **Step 7: Commit** — `git commit -am "refactor(webui): emit full state snapshots from turns/run-agent/module/reconfigure"`.

---

## Task 3: `sessions` SSE event

**Files:** `src/modules/webui/session/sessions-api.ts`; test `tests/webui-push-state.test.ts`.

- [x] **Step 1: Write failing test** (append):

```ts
import { handleSessionCreate, handleSessionDelete } from "../src/modules/webui/session/sessions-api";

it("emits a sessions event on create and delete", () => {
  const s = createWebUiState();
  const { chunks, res } = capture();
  s.clients.add(res);
  const metas = [{ id: "A", name: "A" }];
  s.sessionManager = {
    list: () => metas as never,
    get: () => metas[0] as never,
    getActive: () => "A",
    setActive: () => {},
    delete: () => {},
  };
  // delete path is sync on an idle session
  handleSessionDelete({ writeHead: () => ({ end: () => {} }) } as never, "A", s);
  expect(chunks.join("")).toContain("event: sessions");
});
```

(Adjust the fake `res` to whatever `sendJson` calls; simplest: reuse a `ServerResponse` shim with `writeHead`, `write`, `end`.)

- [x] **Step 2: Implement.** In `sessions-api.ts`:

```ts
import { broadcast, type SseTransport } from "../state";

type SessionMetaLite = { id: string; name?: string; updatedAt?: number; model?: string; messageCount?: number };

function sessionList(s: SessionStore): SessionMetaLite[] {
  if (!s.sessionManager) return [];
  return s.sessionManager.list().map((meta) => ({
    id: meta.id, name: meta.name, updatedAt: meta.updatedAt,
    model: meta.model, messageCount: meta.messageCount,
  }));
}

function emitSessions(s: SessionStore & SseTransport): void {
  broadcast({ type: "sessions", ts: Date.now(), sessions: sessionList(s) }, s);
}
```

Reuse `sessionList` in `handleSessionsGet`. Call `emitSessions(s)` after success in `handleSessionCreate`, `handleSessionActivate`, `handleSessionDelete`.

- [x] **Step 3: Run** — `bun test tests/webui-push-state.test.ts tests/webui-server.test.ts`.
- [x] **Step 4: Commit** — `git commit -am "feat(webui): sessions SSE event on create/activate/delete"`.

---

## Task 4: Pure client routing `state-sync.ts`

**Files:** Create `src/modules/webui/assets/js/state-sync.ts`; test `tests/webui-state-sync.test.ts`.

- [x] **Step 1: Write the module**

```ts
// Pure routing of `state`/`usage` payloads into the per-tab store slices.
// No DOM: this module is the testable core behind `app.ts`'s renderers.
import { tabs as tabState, session } from "./store.js";
import type { Dict } from "./core/store/types.js";

/** Copies run/queue counters from a `state` payload into the session slice. */
export function applyCounters(d: Dict): void {
  session.busy = !!d.busy;
  session.runningSessionId = d.runningSessionId || null;
  session.runningSessionIds =
    d.runningSessionIds || (session.runningSessionId ? [session.runningSessionId] : []);
  session.queued = d.queued || {};
}

/**
 * Routes a `state` payload into the per-tab store. Returns true when the active
 * tab must re-render (payload has no session or targets the active tab).
 */
export function routeState(d: Dict): boolean {
  applyCounters(d);
  const active = tabState.activeTabId;
  if (d.state) {
    const target = typeof d.sessionId === "string" ? d.sessionId : active;
    const tab = target ? tabState.tabs.find((x) => x.id === target) : null;
    if (tab) tab.state = d.state;
  }
  return !d.sessionId || d.sessionId === active;
}

/** Stores a snapshot fetched over REST on its open tab; returns its session id. */
export function storeSnapshot(snapshot: Dict | null | undefined): string | null {
  const sid = snapshot && snapshot.sessionId;
  if (typeof sid !== "string") return null;
  const tab = tabState.tabs.find((x) => x.id === sid);
  if (tab) tab.state = snapshot;
  return sid;
}

/**
 * Merges a partial `usage` payload into the owner tab's snapshot. Returns true
 * when the active tab was affected (caller re-renders the usage bar).
 */
export function mergeUsage(owner: string | null, usage: Dict): boolean {
  const tab = owner ? tabState.tabs.find((x) => x.id === owner) : null;
  if (tab) tab.state = Object.assign({}, tab.state, usage);
  const active = !owner || owner === tabState.activeTabId;
  if (active) session.host = Object.assign({}, session.host, usage);
  return active;
}
```

- [x] **Step 2: Write the test** `tests/webui-state-sync.test.ts` (no DOM needed — store slices are plain objects):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { tabs, session } from "../src/modules/webui/assets/js/core/store/index.js";
import { routeState, storeSnapshot, mergeUsage } from "../src/modules/webui/assets/js/state-sync.js";

beforeEach(() => {
  tabs.tabs = [{ id: "A", kind: "session" }, { id: "B", kind: "session" }];
  tabs.activeTabId = "A";
  session.host = {};
});

describe("state-sync", () => {
  it("routes a snapshot to its owner tab and flags active render", () => {
    expect(routeState({ sessionId: "A", state: { sessionId: "A", contextUsed: 1 } })).toBe(true);
    expect(tabs.tabs[0].state).toMatchObject({ contextUsed: 1 });
  });

  it("stores a background snapshot without flagging active render", () => {
    expect(routeState({ sessionId: "B", state: { sessionId: "B", contextUsed: 2 } })).toBe(false);
    expect(tabs.tabs[1].state).toMatchObject({ contextUsed: 2 });
  });

  it("never overwrites a different tab (guard)", () => {
    routeState({ sessionId: "B", state: { sessionId: "B", contextUsed: 9 } });
    expect(tabs.tabs[0].state).toBeUndefined();
  });

  it("merges usage only into the owner tab", () => {
    expect(mergeUsage("B", { contextUsed: 5 })).toBe(false);
    expect(tabs.tabs[1].state).toMatchObject({ contextUsed: 5 });
    expect(session.host).toEqual({});
    expect(mergeUsage("A", { contextUsed: 7 })).toBe(true);
    expect(session.host).toMatchObject({ contextUsed: 7 });
  });

  it("maps counters and the sessions list is untouched here", () => {
    routeState({ busy: true, runningSessionIds: ["B"], queued: { B: 2 } });
    expect(session.runningSessionIds).toEqual(["B"]);
    expect(session.queued).toEqual({ B: 2 });
  });

  it("storeSnapshot writes to the matching tab", () => {
    expect(storeSnapshot({ sessionId: "B", contextUsed: 3 })).toBe("B");
    expect(tabs.tabs[1].state).toMatchObject({ contextUsed: 3 });
  });
});
```

- [x] **Step 3: Run** — `bun test tests/webui-state-sync.test.ts` → PASS.
- [x] **Step 4: Commit** — `git commit -am "feat(webui): pure per-tab state routing (state-sync)"`.

---

## Task 5: Wire `app.ts` + `tabs.ts`, drop timers

**Files:** `assets/app.ts`, `assets/js/session/tabs.ts`, `assets/js/core/store/index.ts`.

- [x] **Step 1:** `core/store/index.ts` — replace the `applyState` hook with `ensureTabState`:

```ts
export interface StoreHooks {
  // biome-ignore lint/suspicious/noExplicitAny: hook signature owned by app.ts.
  applyStaticI18n: ((...args: any[]) => void) | null;
  ensureTabState?: ((id: string) => void) | null;
}
```

- [x] **Step 2:** `app.ts`:
  - import from `./js/state-sync.js`: `routeState, mergeUsage, storeSnapshot, applyCounters`.
  - Add `fetchState`, `storeSnapshot` use, `ensureTabState`, `renderActiveState`, `applyState` (see spec §3.4). `renderActiveState` body = current `renderState` render part reading `session.host` (set from `activeTab().state`), incl. `updateTabName`.
  - `applyState(d)`: `const render = routeState(d); reflectBusy(); reconcileTabStatuses(); if (d.state?.sessionId) updateTabName(d.state.sessionId, d.state.sessionName); if (render) renderActiveState();`
  - `refresh()`: fetch active tab, auto-open server-active session on boot, `storeSnapshot`, `applyCounters`, `renderActiveState`.
  - `ensureTabState(id)`: memory → render if active; else REST → `storeSnapshot` + render if active.
  - `resyncAfterReconnect()`: for each `session` tab `tab.state = null; void ensureTabState(tab.id)`, then `refresh()` + history reload.
  - SSE `state` handler → `applyState(d)`; add `sessions` handler; `usage` handler → `if (mergeUsage(d.usageSessionId || d.sessionId || null, d.usage)) renderUsage(session.host);`.
  - `hooks.ensureTabState = ensureTabState;` (remove `hooks.applyState`/`hooks.refreshState`).
  - **Delete** `setInterval(refresh, 2000)` and `setInterval(loadSessions, 15000)`.

- [x] **Step 3:** `tabs.ts`: in `openTab`, after `sidebarSessionChanged(id)` add `hooks.ensureTabState?.(id)` for session kind; remove both `hooks.refreshState?.()` calls (lines ~236, ~281) and the stale 15s-comment.

- [x] **Step 4:** Update `tests/webui-assets.test.ts` guard block (~286) to the new strings (`ensureTabState`, no `setInterval(refresh`, no `setInterval(() => void loadSessions`). Add a guard that `app.js` contains `es.addEventListener("sessions"` and no `setInterval(...refresh`.

- [x] **Step 5: Run** — `bun test tests/webui-assets.test.ts tests/webui-state-sync.test.ts tests/webui-frontend-graph.test.ts`.
- [x] **Step 6: Commit** — `git commit -am "refactor(webui): event-sourced sidebar state, drop client polls"`.

---

## Task 6: Docs + quality gate

- [x] **Step 1:** `AGENTS.md` — update the WebUI section: `state`-event carries the snapshot; per-tab `tab.state`; no 2s/15s polls; `sessions` event.
- [x] **Step 2:** `CHANGELOG.md` — add an entry under a new version (MINOR).
- [x] **Step 3:** Run full gate: `bun test && tsc --noEmit && bun run quality`.
- [x] **Step 4: Commit** — `git commit -am "docs: event-sourced web state; test/quality green"`.

---

## Self-review

- **Spec coverage:** §3.1 T1; §3.2 T2; §3.3 T3; §3.4 T4+T5; §5 criteria covered; §6 tests in T1/T4/T5; §7 compatibility (REST shape unchanged) held.
- **Type consistency:** `pushState(s, sessionId?)`, `routeState/mergeUsage/storeSnapshot/applyCounters`, hook `ensureTabState` used consistently.
- **Placeholder scan:** none.
