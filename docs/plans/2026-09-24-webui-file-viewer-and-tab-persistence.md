# Web UI: file viewer hardening + reasoning channel split + tab persistence — Implementation Plan

> **Статус:** исполнено (2026-10-20) — cookie-аутентификация, anchor на `/api/file`,
> отдельный reasoning-канал (SSE `reasoning`), свёрнутый блок reasoning, text/plain-ошибки
> и UTF-16 BOM-декод, персистентность `?session=`. Чекбоксы проставлены по факту.
> Отличие: класс `.fc-open` переименован в `.path`, левый клик открывает файл во вкладке
> Files (`1112c2b4`).

**Goal:** Finish the web file-card/viewer work (anchor Open, no token in URL, UTF-16, human-readable errors) and split reasoning from the generic `meta` channel; persist the active session tab in the URL so a page refresh restores the session.

**Architecture:** The browser stops carrying the app token in the file URL — the server sets an HttpOnly `SameSite=Strict` cookie on any authenticated request and `checkAuth` accepts it, so an ordinary `<a target="_blank">` works. Reasoning gets its own agent callback (`onReasoning`) and its own SSE event (`reasoning`); the generic `meta` channel renders as always-visible dim lines. The active session id is mirrored into `?session=` via `history.replaceState` and restored on boot.

**Tech Stack:** Bun + TypeScript, vitest (`bun test`), inlined browser assets (`app.js`/`styles.css`/`index.html`), i18n (`t()`), Node `fs`/`http`, existing `matchProtectedPath` guard.

**Spec:** none (follow-up to `docs/plans`-tracked web UI work). Changelog entry folds into the unreleased `2.5.0`.

**Branch:** continue on `fix/webui-reasoning-filecard` (already has commits `b1d4679`, `8204ba7`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/modules/webui/util.ts` | `checkAuth` accepts `mma_web_auth` cookie; new `setAuthCookie(res, s)` |
| `src/modules/webui/server.ts` | call `setAuthCookie` after successful auth; pass through `handleFileApi` |
| `src/modules/webui/file-api.ts` | UTF-16 BOM decode, plain-text error bodies, realpath guard (already) |
| `src/core/agent.ts` | new `onReasoning` callback threaded through `run`/`executeSingleAgentLoop` |
| `src/cli/repl.ts`, `src/cli/main.ts` | wire `onReasoning` → `renderer.reasoning` |
| `src/modules/webui/forward.ts` | `Forwarder.onReasoning` → SSE `reasoning` event |
| `src/modules/webui/module.ts` | pass `onReasoning` into `agent.run` |
| `src/modules/webui/assets/app.js` | anchor Open, `onReasoning`/`onMeta` split, `?session=` sync/restore |
| `src/modules/webui/assets/styles.css` | `a.fc-open`, `.metaln` |
| `src/i18n/{en,ru}.json` | `web.file.error.*`, `web.meta.*` (if needed) |
| tests | `webui-auth`, `webui-file`, `webui-forward`, `webui-assets`, agent wiring |

---

## Task 1: Cookie auth so file links need no `?token=`

**Files:**
- Modify: `src/modules/webui/util.ts`
- Modify: `src/modules/webui/server.ts`
- Test: `tests/webui-auth.test.ts`

- [x] **Step 1: Read the existing auth test to match its style**

Run: `Get-Content tests/webui-auth.test.ts`
Note the helper that spins up `handleRequest` with an explicit `WebUiState`.

- [x] **Step 2: Write failing tests for cookie auth**

Add to `tests/webui-auth.test.ts` (import `checkAuth` from `../src/modules/webui/util` and `type { IncomingMessage } from "node:http"`). A browser-forbidden `Cookie` request header is unreliable via `fetch`, so unit-test `checkAuth` directly and only read `Set-Cookie` over HTTP:

```ts
it("checkAuth accepts the mma_web_auth cookie when a token is configured", () => {
  const s = createWebUiState();
  s.token = "s3cret";
  const req = { headers: { cookie: "other=1; mma_web_auth=s3cret" } } as unknown as IncomingMessage;
  expect(checkAuth(req, new URL("http://127.0.0.1/api/state"), s)).toBe(true);
  const bad = { headers: { cookie: "mma_web_auth=nope" } } as unknown as IncomingMessage;
  expect(checkAuth(bad, new URL("http://127.0.0.1/api/state"), s)).toBe(false);
});

it("sets the auth cookie on an authenticated api response", async () => {
  const s = createWebUiState();
  s.token = "s3cret";
  await withServer(s, async (base) => {
    const res = await doFetch(base + "/api/i18n", { headers: { "x-mma-token": "s3cret" } });
    expect(res.headers.get("set-cookie") || "").toContain("mma_web_auth=s3cret");
  });
});
```

- [x] **Step 3: Run to verify it fails**

Run: `bun test tests/webui-auth.test.ts`
Expected: FAIL (cookie not accepted / no set-cookie).

- [x] **Step 4: Implement cookie parsing + setter in `util.ts`**

Add below `safeEqual`:

```ts
/** Name of the HttpOnly cookie that carries the web token for GET navigations. */
const AUTH_COOKIE = "mma_web_auth";

/** Read a cookie value from a raw `Cookie:` header. */
function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * Hand the browser a same-site cookie holding the token so a plain
 * `<a target="_blank" href="/api/file?...">` navigation (which cannot set the
 * `x-mma-token` header) still authenticates. `SameSite=Strict` means a
 * cross-site request never carries it, so this adds no CSRF surface.
 */
export function setAuthCookie(res: ServerResponse, s: WebUiState): void {
  if (!s.token) return;
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=${encodeURIComponent(s.token)}; Path=/; HttpOnly; SameSite=Strict`,
  );
}
```

Change `checkAuth` to also accept the cookie:

```ts
export function checkAuth(req: IncomingMessage, reqUrl: URL, s: WebUiState): boolean {
  if (!s.token) return true;
  const header = req.headers["x-mma-token"];
  if (typeof header === "string" && safeEqual(header, s.token)) return true;
  const query = reqUrl.searchParams.get("token");
  if (query !== null && safeEqual(query, s.token)) return true;
  const cookie = cookieValue(req.headers.cookie, AUTH_COOKIE);
  return cookie !== null && safeEqual(cookie, s.token);
}
```

- [x] **Step 5: Set the cookie in `server.ts` after auth passes**

Import `setAuthCookie`, then in `handleRequest`:

```ts
if (reqUrl.pathname === "/events") {
  if (!checkAuth(req, reqUrl, s)) { sendJson(res, 401, { error: "unauthorized" }); return; }
  setAuthCookie(res, s);
  handleEvents(req, res, s);
  return;
}
// ...
if (reqUrl.pathname.startsWith("/api/")) {
  if (!checkAuth(req, reqUrl, s)) { sendJson(res, 401, { error: "unauthorized" }); return; }
  if (!sameOrigin(req, reqUrl)) { sendJson(res, 403, { error: "cross-origin requests are not allowed" }); return; }
  setAuthCookie(res, s);
  handleApi(req, res, reqUrl, s);
  return;
}
```

- [x] **Step 6: Run tests**

Run: `bun test tests/webui-auth.test.ts tests/webui-server.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/modules/webui/util.ts src/modules/webui/server.ts tests/webui-auth.test.ts
git commit -m "feat(webui): set/accept SameSite token cookie for GET navigations"
```

---

## Task 2: File card uses a real anchor (no token in URL)

**Files:**
- Modify: `src/modules/webui/assets/app.js` (`openFileViewer` + `cardFor`)
- Modify: `src/modules/webui/assets/styles.css`
- Test: `tests/webui-assets.test.ts`

- [x] **Step 1: Write a failing asset guard**

Replace the existing `wires the file card's Open button` test in `tests/webui-assets.test.ts` with:

```ts
it("wires the file card's Open link to /api/file in a new tab", () => {
  const a = loadAssets();
  expect(a.js).toContain("/api/file?path=");
  expect(a.js).toContain('target = "_blank"');
  expect(a.js).not.toContain("window.open(");
  expect(a.css).toContain(".filecard .fc-open");
});
```

- [x] **Step 2: Run to verify it fails**

Run: `bun test tests/webui-assets.test.ts`
Expected: FAIL (current code uses `window.open` and appends `token`).

- [x] **Step 3: Replace `openFileViewer` with an anchor and use it in `cardFor`**

In `app.js`, delete `openFileViewer` and in `cardFor` replace the button block:

```js
      const bottom = el("div", "fc-bottom");
      bottom.appendChild(el("span", "lab", labelOf(name)));
      if (OPENABLE_TOOLS.indexOf(name) !== -1) {
        const open = el("a", "fc-open", t("web.card.open"));
        open.href = "/api/file?path=" + encodeURIComponent(path);
        open.target = "_blank";
        open.rel = "noopener";
        open.title = t("web.card.open");
        bottom.appendChild(open);
      }
      card.appendChild(bottom);
```

- [x] **Step 4: Style the anchor like the button**

In `styles.css` replace the `.filecard .fc-open` rules:

```css
.filecard .fc-open {
  flex: 0 0 auto; font: inherit; font-size: 12px; line-height: 1.4;
  color: var(--accent); background: transparent; border: 1px solid var(--border-2);
  border-radius: 4px; padding: 2px 10px; cursor: pointer; text-decoration: none;
}
.filecard .fc-open:hover { border-color: var(--accent); text-decoration: none; }
.filecard .fc-open:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
```

- [x] **Step 5: Run tests**

Run: `bun test tests/webui-assets.test.ts`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/modules/webui/assets/app.js src/modules/webui/assets/styles.css tests/webui-assets.test.ts
git commit -m "feat(webui): file card Open is a real new-tab link (no token in URL)"
```

---

## Task 3: Dedicated reasoning channel (agent → REPL/web)

**Files:**
- Modify: `src/core/agent.ts`
- Modify: `src/cli/repl.ts`, `src/cli/main.ts`
- Modify: `src/modules/webui/forward.ts`, `src/modules/webui/module.ts`
- Test: `tests/webui-forward.test.ts`

- [x] **Step 1: Write a failing forwarder test**

Add to `tests/webui-forward.test.ts`:

```ts
it("emits a dedicated reasoning event, not meta", () => {
  vi.useFakeTimers();
  const s = createWebUiState();
  const seen: SseEvent[] = [];
  const fwd = makeForwarder(s, (ev) => seen.push(ev));
  fwd.onReasoning("why");
  fwd.onMeta("stats");
  vi.advanceTimersByTime(350);
  expect(seen.map((e) => e.type)).toEqual(["reasoning", "meta"]);
});
```

- [x] **Step 2: Run to verify it fails**

Run: `bun test tests/webui-forward.test.ts`
Expected: FAIL (`fwd.onReasoning is not a function`).

- [x] **Step 3: Add `onReasoning` to the forwarder**

In `forward.ts`: add to the `Forwarder` interface and buffer it separately.

```ts
export interface Forwarder {
  onText(chunk: string): void;
  onMeta(chunk: string): void;
  onReasoning(chunk: string): void;
  // ...unchanged...
}
```

At the top of `makeForwarder`:

```ts
  let buf = { text: "", meta: "", reasoning: "" };
```

In `flush()` (before the text block) add:

```ts
    if (buf.reasoning) {
      sink({ type: "reasoning", ts: Date.now(), chunk: stripAnsi(buf.reasoning) });
      buf.reasoning = "";
    }
```

In the returned object add next to `onMeta`:

```ts
    onReasoning(chunk) {
      buf.reasoning += chunk;
      schedule();
    },
```

- [x] **Step 4: Thread `onReasoning` through the agent**

In `src/core/agent.ts`:

`run(...)` signature (line ~501) — append the new callback:

```ts
  async run(
    input: string,
    onChunk?: (chunk: string) => void,
    onMeta?: (meta: string) => void,
    onTool?: (ev: ToolEvent) => void,
    onPhase?: (phase: AgentPhase) => void,
    onReasoning?: (reasoning: string) => void,
  ): Promise<AgentResult> {
```

Update the two dispatches (lines ~632, ~642) and the MoE lambda to pass `onReasoning`:

```ts
            () => this.executeSingleAgentLoop(input, slog, onChunk, onMeta, countTool, onPhase, onReasoning),
```
```ts
        : await this.executeSingleAgentLoop(input, slog, onChunk, onMeta, countTool, onPhase, onReasoning);
```

`executeSingleAgentLoop(...)` signature (line ~673) — append `onReasoning?: (reasoning: string) => void,`.

Replace the reasoning emission (line ~880):

```ts
          if (chunk.type === "reasoning" && chunk.content) {
            reasoningContent += chunk.content;
            if (config.showReasoning) {
              const metaOut = pluginManager.runOnMeta(
                { iteration: state.iteration, logger, contextManager },
                chunk.content,
              );
              if (metaOut) {
                onReasoning?.(metaOut);
              }
              emittedReasoning = true;
            }
          }
```

(The old `onMeta?.(pc.dim(metaOut))` is removed — the renderer/forwarder no longer receive a pre-dimmed string.)

Also update the reasoning→text separator (line ~866) so it stays on the reasoning channel:

```ts
          if (chunk.type === "text" && chunk.content) {
            if (emittedReasoning && !textContent) {
              onReasoning?.("\n\n");
            }
```

- [x] **Step 5: Update the existing agent test**

`tests/core/agent.test.ts:1187` asserts reasoning arrives via `onMeta`. Rename it and pass the new callback (6th argument):

```ts
  it("streams reasoning via onReasoning when showReasoning is true", async () => {
    // ...unchanged provider mock...
    const reasoning: string[] = [];
    const text: string[] = [];
    await agent.run(
      "test",
      (c) => text.push(c),
      () => {},
      undefined,
      undefined,
      (r) => reasoning.push(r),
    );

    expect(reasoning.some((c) => c.includes("Let me think"))).toBe(true);
    expect(text.some((c) => c.includes("Answer"))).toBe(true);
    expect(text.some((c) => c.includes("Let me think"))).toBe(false);
  });
```

- [x] **Step 6: Wire REPL and one-shot renderers**

`src/cli/repl.ts` — add the 6th argument after the phase callback:

```ts
        (reasoning) => renderer.reasoning(reasoning),
```

`src/cli/main.ts` — same, after the phase callback:

```ts
        (reasoning) => renderer.reasoning(reasoning),
```

- [x] **Step 7: Wire the web module**

`src/modules/webui/module.ts` — after the phase callback in `deps.agent.run(...)`:

```ts
        (phase) => forwarder.onPhase(phase),
        (reasoning) => forwarder.onReasoning(reasoning),
```

- [x] **Step 8: Run tests**

Run: `bun test tests/webui-forward.test.ts tests/webui-server.test.ts tests/core/agent.test.ts`
Expected: PASS.

- [x] **Step 9: Commit**

```bash
git add src/core/agent.ts src/cli/repl.ts src/cli/main.ts src/modules/webui/forward.ts src/modules/webui/module.ts tests/webui-forward.test.ts tests/core/agent.test.ts
git commit -m "feat(agent): dedicated onReasoning channel (separate from meta)"
```

---

## Task 4: Browser renders reasoning collapsed, meta as visible lines

**Files:**
- Modify: `src/modules/webui/assets/app.js`
- Modify: `src/modules/webui/assets/styles.css`
- Test: `tests/webui-assets.test.ts`

- [x] **Step 1: Write failing asset guards**

Add to `tests/webui-assets.test.ts`:

```ts
it("listens for the dedicated reasoning event", () => {
  const a = loadAssets();
  expect(a.js).toContain('addEventListener("reasoning"');
  expect(a.js).toContain("onReasoning(");
  expect(a.css).toContain(".metaln");
});
```

- [x] **Step 2: Run to verify it fails**

Run: `bun test tests/webui-assets.test.ts`
Expected: FAIL.

- [x] **Step 3: Rename the live reasoning block state and add a meta line**

In `app.js`:

- Rename `curMeta` → `curThink` everywhere (declaration + `onText`/`finishMeta`/`onMeta`/`onTurnEnd`).
- Replace `onMeta(chunk, sid)` with two functions:

```js
  function onReasoning(chunk, sid) {
    const feed = feedForEvent(sid);
    clearBusy(feed);
    if (!feed) return;
    clearEmpty(feed);
    curText = null;
    if (!curThink) {
      flushRun();
      const wrap = el("div", "think");
      const head = el("button", "think-h");
      head.type = "button";
      head.setAttribute("aria-expanded", "false");
      head.appendChild(el("span", "g", "✦"));
      head.appendChild(el("span", "lab", t("web.action.thinking")));
      head.appendChild(el("span", "dur", ""));
      const tog = el("span", "tog");
      setIcon(tog, "chevron-right", t("web.action.show"));
      head.appendChild(tog);
      const body = el("div", "think-body hidden");
      wrap.appendChild(head);
      wrap.appendChild(body);
      appendTo(feed, wrap);
      curThink = { wrap, head, body, startedAt: Date.now() };
    }
    curThink.body.textContent += chunk;
    if (feed === activeFeed()) scroll();
  }

  // Generic agent status (context stats, compaction, MoE status, warnings):
  // always visible, one dim line per chunk, never collapsed.
  function onMeta(chunk, sid) {
    const feed = feedForEvent(sid);
    clearBusy(feed);
    const text = (chunk || "").trim();
    if (!feed || !text) return;
    clearEmpty(feed);
    curText = null;
    const warn = text.indexOf("⚠") !== -1 || text.indexOf("✗") !== -1;
    appendTo(feed, el("div", warn ? "metaln warn" : "metaln", text));
    if (feed === activeFeed()) scroll();
  }
```

- Delete the old auto-expand block inside the removed `onMeta` (it is superseded: warnings now always show as `.metaln.warn`).

- In `connectSSE()` add the reasoning listener next to `meta`:

```js
    es.addEventListener("reasoning", (e) => {
      const d = parse(e);
      if (d) onReasoning(d.chunk || "", d.sessionId);
    });
```

- [x] **Step 4: Add the meta-line style**

In `styles.css` (near the think styles):

```css
.metaln {
  color: var(--dim-c); padding-left: 26px; white-space: pre-wrap;
  font-size: 12.5px; overflow-wrap: anywhere;
}
.metaln.warn { color: var(--yellow); }
```

- [x] **Step 5: Run tests + typecheck**

Run: `bun test tests/webui-assets.test.ts && npx tsc --noEmit`
Expected: PASS / clean.

- [x] **Step 6: Commit**

```bash
git add src/modules/webui/assets/app.js src/modules/webui/assets/styles.css tests/webui-assets.test.ts
git commit -m "feat(webui): collapse reasoning, render meta as always-visible lines"
```

---

## Task 5: Human-readable file viewer errors + UTF-16 support

**Files:**
- Modify: `src/modules/webui/file-api.ts`
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/webui-file.test.ts`

- [x] **Step 1: Write failing tests**

In `tests/webui-file.test.ts`, change the out-of-workspace / protected / missing assertions to expect a plain-text body, and add UTF-16 + directory cases:

```ts
it("answers plain-text errors so a new tab shows a readable message", async () => {
  const ws = makeWorkspace();
  const s = createWebUiState();
  s.workspace = ws;
  await withServer(s, async (base) => {
    const res = await doFetch(base + "/api/file?path=../../secret.txt");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/plain");
    // Locale-independent: a readable message, not a JSON error object.
    expect((await res.text()).startsWith("{")).toBe(false);
  });
});

it("serves a UTF-16LE text file", async () => {
  const ws = makeWorkspace();
  writeFileSync(join(ws, "u16.txt"), Buffer.from("\uFEFFhello", "utf16le"));
  const s = createWebUiState();
  s.workspace = ws;
  await withServer(s, async (base) => {
    const res = await doFetch(base + "/api/file?path=u16.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });
});

it("answers a readable message for a directory", async () => {
  const ws = makeWorkspace();
  const s = createWebUiState();
  s.workspace = ws;
  await withServer(s, async (base) => {
    const res = await doFetch(base + "/api/file?path=" + encodeURIComponent(ws));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });
});
```

Also update the existing `rejects a path outside the workspace`, `rejects protected paths`, and `answers 404 … 400` tests: replace `await res.json()` assertions with `expect(res.headers.get("content-type")).toContain("text/plain")` and drop the JSON-body equality (the status codes stay the same).

- [x] **Step 2: Run to verify it fails**

Run: `bun test tests/webui-file.test.ts`
Expected: FAIL (JSON bodies / UTF-16 refused as binary).

- [x] **Step 3: Add i18n keys**

`src/i18n/en.json`:

```json
  "web.file.error.missing_path": "No file path was given.",
  "web.file.error.outside_workspace": "This file is outside the agent workspace and cannot be opened.",
  "web.file.error.protected_path": "This file is protected (secrets/VCS) and cannot be opened.",
  "web.file.error.too_large": "File is too large to open in the browser ({limit} bytes max).",
  "web.file.error.binary_file": "This looks like a binary file and cannot be shown as text.",
  "web.file.error.not_found": "File not found (it may be a directory or it was deleted).",
  "web.file.error.workspace_unavailable": "No workspace is open.",
```

`src/i18n/ru.json` (same keys):

```json
  "web.file.error.missing_path": "Не указан путь к файлу.",
  "web.file.error.outside_workspace": "Файл вне рабочей папки агента — открыть нельзя.",
  "web.file.error.protected_path": "Файл защищён (секреты/VCS) — открыть нельзя.",
  "web.file.error.too_large": "Файл слишком большой для показа в браузере (максимум {limit} байт).",
  "web.file.error.binary_file": "Похоже на бинарный файл — текстом показать нельзя.",
  "web.file.error.not_found": "Файл не найден (возможно, это папка или он удалён).",
  "web.file.error.workspace_unavailable": "Рабочая папка не открыта.",
```

- [x] **Step 4: Rewrite `file-api.ts` responses**

Replace `sendJson` import usage with a text helper and add UTF-16 detection:

```ts
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { matchProtectedPath } from "../security/protected-paths";
import { t } from "../../i18n/index";
import type { WebUiState } from "./state";

export const MAX_FILE_VIEW_BYTES = 512 * 1024;

/** The viewer is opened as a browser tab — errors must read as text, not JSON. */
function sendTextError(res: ServerResponse, status: number, key: string, vars?: Record<string, string>): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(t(key, vars));
}
```

Replace every `sendJson(res, N, { error: "X" })` with `sendTextError(res, N, "web.file.error.X", vars?)`. In `serveFile`, after the size check, replace the NUL check with BOM-aware decoding:

```ts
    const { text, binary } = decodeText(buf);
    if (binary) {
      sendTextError(res, 415, "web.file.error.binary_file");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(text);
```

Add at module scope:

```ts
/** Decode a text buffer, honouring a UTF-16 BOM; NUL elsewhere means binary. */
export function decodeText(buf: Buffer): { text: string; binary: boolean } {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString("utf16le"), binary: false };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return { text: swapped.toString("utf16le"), binary: false };
  }
  if (buf.includes(0)) return { text: "", binary: true };
  return { text: buf.toString("utf8"), binary: false };
}
```

- [x] **Step 5: Run tests**

Run: `bun test tests/webui-file.test.ts tests/webui-i18n.test.ts`
Expected: PASS (i18n parity holds).

- [x] **Step 6: Commit**

```bash
git add src/modules/webui/file-api.ts src/i18n/en.json src/i18n/ru.json tests/webui-file.test.ts
git commit -m "fix(webui): readable /api/file errors + UTF-16 BOM decoding"
```

---

## Task 6: Persist the active session in `?session=`

**Files:**
- Modify: `src/modules/webui/assets/app.js`
- Test: `tests/webui-assets.test.ts`

- [x] **Step 1: Write a failing asset guard**

Add to `tests/webui-assets.test.ts`:

```ts
it("persists the active session in the URL and restores it on boot", () => {
  const a = loadAssets();
  expect(a.js).toContain("replaceState");
  expect(a.js).toContain('searchParams.set("session"');
  expect(a.js).toContain('URLSearchParams(location.search).get("session")');
});
```

- [x] **Step 2: Run to verify it fails**

Run: `bun test tests/webui-assets.test.ts`
Expected: FAIL.

- [x] **Step 3: Add `syncUrl` and call it on tab changes**

In `app.js`, add near `openTab`:

```js
  // Mirror the active session into `?session=` so a page refresh restores it.
  // Only the active tab is persisted; the token param is preserved as-is.
  function syncUrl() {
    const url = new URL(location.href);
    const tab = tabs.find((x) => x.id === activeTabId);
    if (tab && tab.kind === "session") url.searchParams.set("session", tab.id);
    else url.searchParams.delete("session");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
```

Call `syncUrl();` at the end of `openTab`, `closeTab`, and in `showEmptyFeed` (after clearing), and in `renderState` after the auto-open block.

- [x] **Step 4: Restore the session on boot**

Capture the requested session **before** any `syncUrl()` can strip it (boot calls `showEmptyFeed()` early), then restore after the session list is loaded. At the top of `boot()` add:

```js
  async function boot() {
    const initialSession = new URLSearchParams(location.search).get("session");
    await loadI18n();
```

After `await loadSessions();` add:

```js
    if (initialSession && state.sessions.some((s) => s.id === initialSession)) {
      const meta = state.sessions.find((s) => s.id === initialSession);
      openTab(initialSession, (meta && meta.name) || String(initialSession), "session", true);
    }
```

`openTab(..., true)` already calls `/api/sessions/activate` and `loadHistory`.

- [x] **Step 5: Run tests + typecheck**

Run: `bun test tests/webui-assets.test.ts && npx tsc --noEmit`
Expected: PASS / clean.

- [x] **Step 6: Manual check**

Run: `bun run mma web` from the repo root, open two sessions, reload the page → the active session tab is restored; the URL shows `?session=<id>`.

- [x] **Step 7: Commit**

```bash
git add src/modules/webui/assets/app.js tests/webui-assets.test.ts
git commit -m "feat(webui): persist active session in ?session= and restore on reload"
```

---

## Task 7: Docs, changelog, version

**Files:**
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`

- [x] **Step 1: Update `AGENTS.md`**

In the "Browser Mode" transport line, add the `reasoning` SSE event and note the cookie:

```
SSE `GET /events` (`state, text, meta, reasoning, phase, tool_start, tool_end, turn_end, plan, command, error`)
```

After the transport sentence add:

```
Browser GET navigations authenticate via an HttpOnly `SameSite=Strict` `mma_web_auth` cookie (set on any authenticated request) so `/api/file` opens from a plain link without the token in the URL.
```

- [x] **Step 2: Fold into the unreleased `2.5.0` CHANGELOG entry**

Move the three new items under the existing `## [2.5.0]` headings and add:

```md
- **web file viewer**: BOM-aware UTF-16 decoding; `/api/file` answers readable plain-text errors (so a new tab explains "outside workspace" / "protected" / "directory" instead of JSON); the file card `open` is a real `<a target="_blank">` link, authenticated by a `SameSite=Strict` cookie instead of a token in the URL.
- **web reasoning channel**: reasoning now travels on its own agent callback and SSE `reasoning` event; the generic `meta` channel (context stats, compaction, warnings) renders as always-visible lines instead of being mixed into the collapsed "thinking" block.
- **web session persistence**: the active session is mirrored into `?session=` (`history.replaceState`) and restored on reload.
```

- [x] **Step 3: Commit**

```bash
git add AGENTS.md CHANGELOG.md
git commit -m "docs: webui file viewer, reasoning channel and session persistence"
```

---

## Task 8: Final verification

- [x] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [x] **Step 2: Full suite**

Run: `bun test`
Expected: `0 fail`.

- [x] **Step 3: Manual smoke (optional, if a provider is configured)**

Run: `bun run mma web`
Check: file card Open works in a new tab (loopback, with `MMA_WEBUI_TOKEN` set too); reasoning is collapsed; context-stats lines stay visible; reload restores the session.

---

## Notes / open decisions

- **Cookie vs fetch/blob:** chose cookie auth because it is the only way to keep a real `<a>` (middle-click / open-in-new-tab / copy link) *and* avoid the long-lived token in the URL. `SameSite=Strict` + existing same-origin write check mean no new CSRF surface. If you'd rather not touch auth, the alternative is fetch with the `x-mma-token` header → `Blob` → `window.open`, at the cost of anchor semantics.
- **EventSource** still sends `?token=` (kept for backward compatibility); it could be switched to the cookie later.
- Version stays **2.5.0** (unreleased) — these are folded in rather than bumped.
