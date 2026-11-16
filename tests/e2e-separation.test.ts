/**
 * E2E сепарации (split W11): настоящий демон + web-адаптер в отдельных
 * процессах-ролях, браузерный API поверх них.
 *
 * Проверяем сквозной путь: браузер → адаптер → `/v1/host/*` → рантайм → SSE,
 * включая HITL-вопрос, провайдеров, LSP-таблицу, память и файлы. Адаптер не
 * конструирует `Agent`/`SessionManager` — иначе тест не прошёл бы по поведению
 * (вопрос пришёл бы из локального раннера, а не из демона).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../src/core/types";
import type { PromptIO } from "../src/tools/prompt-io";
import { startAgentService } from "../src/modules/service/module";
import { RemoteHost } from "../src/modules/daemon/remote-host";
import { startWebDaemon, type WebDaemonHandle } from "../src/modules/webui/daemon-module";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./service/harness";

let dir: string;
let stopDaemon: (() => void) | undefined;
let base: string;
let sessionId: string;
let host: RemoteHost | undefined;
let web: WebDaemonHandle | undefined;
let abort: AbortController | undefined;

/** Агент спрашивает и возвращает ответ — тот же сценарий у CLI и веба. */
function askingAgent(state: { io?: PromptIO }) {
  return {
    setPromptIO(io: PromptIO) {
      state.io = io;
    },
    async run(_input: string, onChunk?: (c: string) => void): Promise<AgentResult> {
      const answer = await state.io!.askText("Pick a color?");
      onChunk?.(`\n${answer}`);
      return { success: true, text: answer, iterationCount: 1 };
    },
    shutdown() {},
    pause() {},
    resume() {},
  };
}

interface SseEvent {
  type: string;
  [k: string]: unknown;
}

let webUrl = "";

/** Читает SSE-поток адаптера в общий массив до отмены. */
async function collectSse(url: string, signal: AbortSignal, out: SseEvent[]): Promise<void> {
  const res = await fetch(url, { signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let cut = buf.indexOf("\n\n");
      while (cut >= 0) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (data) {
          try {
            out.push(JSON.parse(data) as SseEvent);
          } catch {
            /* комментарий/keep-alive */
          }
        }
        cut = buf.indexOf("\n\n");
      }
    }
  } catch {
    /* поток закрыт */
  }
}

async function waitFor(fn: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${webUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

beforeEach(async () => {
  dir = tempServiceDir();
  const state: { io?: PromptIO } = {};
  const deps = makeServiceDeps({ dir, agent: askingAgent(state) });
  deps.memory = {
    getPreferences: () => ({ tone: "brief" }),
    read: () => "- fact",
    append: () => undefined,
    deleteEntry: () => true,
  } as never;
  const svc = startAgentService(deps);
  stopDaemon = svc.stop;
  base = await svc.url;
  sessionId = await firstSessionId(base);

  host = new RemoteHost({ baseUrl: base });
  web = await startWebDaemon({ daemon: host });
  webUrl = await web.url;
  abort = new AbortController();
});

afterEach(() => {
  abort?.abort();
  web?.stop();
  host?.dispose();
  stopDaemon?.();
  stopDaemon = undefined;
  cleanupServiceDir(dir);
  web = undefined;
  host = undefined;
});

describe("e2e: daemon + web adapter (W11)", () => {
  it("runs a turn with a question through the real daemon and streams it", async () => {
    const events: SseEvent[] = [];
    void collectSse(`${webUrl}/events`, abort!.signal, events);

    const sent = await json("/api/message", {
      method: "POST",
      body: JSON.stringify({ text: "start", sessionId }),
    });
    expect(sent.status).toBe(202);

    await waitFor(() => events.some((e) => e.type === "question"), 8000);
    const question = events.find((e) => e.type === "question") as { id?: string } | undefined;
    expect(question?.id).toBeTruthy();

    const answered = await json("/api/answer", {
      method: "POST",
      body: JSON.stringify({ id: question!.id, answer: "blue" }),
    });
    expect(answered.status).toBe(202);

    await waitFor(() => events.some((e) => e.type === "turn_end"), 8000);
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => String(e.chunk ?? ""))
      .join("");
    expect(text).toContain("blue");
  });

  it("serves providers, LSP, memory and files through the daemon", async () => {
    const providers = await json("/api/providers");
    expect(providers.status).toBe(200);

    const saved = await json("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        type: "openai",
        baseUrl: "http://localhost:9999/v1",
        label: "e2e",
      }),
    });
    expect(saved.status).toBe(200);
    const after = await json("/api/providers");
    expect(JSON.stringify(after.body)).toContain("e2e");

    const lsp = await json("/api/lsp");
    expect(lsp.status).toBe(200);
    expect(Array.isArray(lsp.body.servers)).toBe(true);

    const memory = await json("/api/memory");
    expect(memory.status).toBe(200);
    expect(Array.isArray(memory.body.categories)).toBe(true);

    const files = await json("/api/files?path=");
    expect(files.status).toBe(200);
    expect(Array.isArray(files.body.entries)).toBe(true);

    const search = await json("/api/search?q=package&names=1");
    expect(search.status).toBe(200);
    expect(Array.isArray(search.body.results)).toBe(true);
  });

  it("lists sessions and the state snapshot from the daemon", async () => {
    const stateRes = await json("/api/state");
    expect(stateRes.status).toBe(200);
    expect((stateRes.body.state as { sessionId?: string }).sessionId).toBeTruthy();

    const sessions = await json("/api/sessions");
    expect(sessions.status).toBe(200);
    expect(
      (sessions.body.sessions as Array<{ id: string }>).some((s) => s.id === sessionId),
    ).toBe(true);

    const commands = await json("/api/commands");
    expect(commands.status).toBe(200);
    const list = commands.body.commands as Array<{ name: string; desc: string }>;
    expect(list.some((c) => c.name === "config")).toBe(true);
    expect(list.find((c) => c.name === "wizard")?.desc).toContain("terminal-only");
  });
});
