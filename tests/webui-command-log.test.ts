// B-35: slash commands from `mma web` leave a journal record in session.jsonl.
// `/export` runs server-side; `/clear` and `/new` are browser-only and reach the
// server through a dedicated `{action}` form that only logs, never executes.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebUiState } from "../src/modules/webui/state";
import { makeWebCommands } from "../src/modules/webui/chat/commands";
import { SessionStore } from "../src/modules/session/store";
import { SessionManager } from "../src/modules/session/manager";
import type { SessionLogEntry } from "../src/modules/session/store";
import { withServer, postJson } from "./helpers/webui-server";
import { setupHappyDom } from "./helpers/happy-dom";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-web-command-log-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function manager(): SessionManager {
  const store = new SessionStore(join(dir, "sessions"));
  store.init();
  return new SessionManager(store, {
    model: "m",
    contextWindow: 1024,
    projectDir: dir,
    maxSessions: 10,
    logger: { warn: () => {} },
  });
}

describe("webui: slash commands are journaled (B-35)", () => {
  it("POST /api/command appends a command record with the result", async () => {
    const m = manager();
    const meta = m.create("journal");
    m.appendMessage({ role: "user", content: "hello", timestamp: new Date().toISOString() });
    const s = createWebUiState();
    s.sessionManager = m;
    const dispatch = makeWebCommands({ state: s });
    s.bridge = {
      isBusy: () => false,
      submit: () => Promise.resolve(),
      interrupt: () => {},
      getState: () => ({ busy: false }),
      executeCommand: dispatch,
    } as never;

    const out = join(dir, "export.md");
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/command", {
        sessionId: meta.id,
        line: `/export --out ${out}`,
      });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 50));
    });

    const log = m.loadSessionLog(meta.id) as SessionLogEntry[];
    const command = log.find((e) => e.type === "command");
    expect(command).toBeTruthy();
    expect(command?.source).toBe("module:webui");
    expect(command?.content).toBe(`/export --out ${out}`);
    expect(command?.success).toBe(true);
    expect(command?.status).toBe("ok");
    expect(String(command?.message)).toContain("exported");
  });

  it("a client-only action is journaled without running a server command", async () => {
    const m = manager();
    const meta = m.create("client");
    const s = createWebUiState();
    s.sessionManager = m;
    let executed = 0;
    const dispatch = makeWebCommands({ state: s });
    s.bridge = {
      isBusy: () => false,
      submit: () => Promise.resolve(),
      interrupt: () => {},
      getState: () => ({ busy: false }),
      executeCommand: (line: string) => {
        executed++;
        return dispatch(line);
      },
    } as never;

    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/command", { sessionId: meta.id, action: "clear" });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(executed).toBe(0);
    const command = (m.loadSessionLog(meta.id) as SessionLogEntry[]).find((e) => e.type === "command");
    expect(command?.content).toBe("/clear");
    expect(command?.success).toBe(true);
    expect(command?.message).toBe("client-side");
  });

  it("writes a background tab's command to its own session, not the active one", async () => {
    const m = manager();
    const active = m.create("active");
    const background = m.create("background");
    m.setActive(active.id);
    const s = createWebUiState();
    s.sessionManager = m;
    // A turn is running: the handler cannot switch the active session.
    s.busy = true;
    s.bridge = {
      isBusy: () => true,
      submit: () => Promise.resolve(),
      interrupt: () => {},
      getState: () => ({ busy: true }),
      executeCommand: () => Promise.resolve(),
    } as never;

    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/command", {
        sessionId: background.id,
        action: "clear",
      });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 20));
    });

    const own = (m.loadSessionLog(background.id) as SessionLogEntry[]).find(
      (e) => e.type === "command",
    );
    const foreign = (m.loadSessionLog(active.id) as SessionLogEntry[]).find(
      (e) => e.type === "command",
    );
    expect(own?.content).toBe("/clear");
    expect(foreign).toBeUndefined();
  });

  it("an unknown client action is rejected, not guessed", async () => {
    const s = createWebUiState();
    s.sessionManager = manager();
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/command", { action: "explode" });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("unknown_action");
    });
  });
});

describe("webui: composer journals client-only commands (B-35)", () => {
  const win = setupHappyDom();

  it("logClientCommand posts the dedicated action", async () => {
    const { logClientCommand } = await import(
      "../src/modules/webui/assets/js/session/client-command-log.js"
    );
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return { ok: true, status: 202, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      logClientCommand("clear", "ses_1");
      await new Promise((r) => win.setTimeout(r, 10));
      logClientCommand("new", null);
      await new Promise((r) => win.setTimeout(r, 10));
    } finally {
      globalThis.fetch = original;
    }
    expect(calls[0]).toEqual({ url: "/api/command", body: { action: "clear", sessionId: "ses_1" } });
    expect(calls[1]).toEqual({ url: "/api/command", body: { action: "new" } });
  });

  it("composer wires both local commands to the journal helper", () => {
    const src = readFileSync(
      new URL("../src/modules/webui/assets/js/session/composer.ts", import.meta.url),
      "utf-8",
    );
    expect(src).toContain('logClientCommand("clear", sessionId)');
    expect(src).toContain('logClientCommand("new", sessionId)');
  });

  it("no direct pre-journal early return remains for clear/new", () => {
    const src = readFileSync(
      new URL("../src/modules/webui/assets/js/session/composer.ts", import.meta.url),
      "utf-8",
    );
    // The old branch cleared/opened before notifying the server.
    expect(src).not.toMatch(/if \(name === "clear"\) \{\s*clearFeed\(feed\);\s*return;/);
  });
});
