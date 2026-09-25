import { describe, it, expect, afterEach } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { handleRequest, stopServer } from "../src/modules/webui/server";
import { createWebUiState } from "../src/modules/webui/state";
import {
  cancelPendingQuestions,
  createWebPromptIO,
  resolveAnswer,
} from "../src/modules/webui/prompt-io";

const assets = { html: "<h1>hi</h1>", css: "body{}", js: "//ok" };

// Other tests in the shared process may stub globalThis.fetch; use the runtime's
// own fetch so HTTP assertions stay real.
const doFetch: typeof fetch =
  typeof Bun !== "undefined" ? (Bun as unknown as { fetch: typeof fetch }).fetch.bind(Bun) : fetch;

async function withServer(
  s: ReturnType<typeof createWebUiState>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const srv = createServer((req, res) => handleRequest(req, res, assets, s));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    srv.close();
  }
}

/** Collect SSE payloads broadcast to the state (broadcast only calls write). */
function captureEvents(s: ReturnType<typeof createWebUiState>): string[] {
  const chunks: string[] = [];
  const fake = {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: () => {},
  };
  s.clients.add(fake as unknown as ServerResponse);
  return chunks;
}

/** The id of the only pending question, once registered. */
function onlyPendingId(s: ReturnType<typeof createWebUiState>): string {
  const ids = [...s.pendingQuestions.keys()];
  expect(ids).toHaveLength(1);
  return ids[0];
}

describe("webui PromptIO", () => {
  afterEach(() => stopServer());

  it("askText broadcasts a text question and resolves via resolveAnswer", async () => {
    const s = createWebUiState();
    const events = captureEvents(s);
    const io = createWebPromptIO(s);

    const answer = io.askText("What is your name?");
    const id = onlyPendingId(s);
    expect(events.join("")).toContain("event: question");
    expect(events.join("")).toContain('"kind":"text"');
    expect(events.join("")).toContain("What is your name?");

    expect(resolveAnswer(s, id, "Ada")).toBe(true);
    await expect(answer).resolves.toBe("Ada");
    expect(s.pendingQuestions.size).toBe(0);
  });

  it("askChoice broadcasts labels + flags and resolves to indices", async () => {
    const s = createWebUiState();
    const events = captureEvents(s);
    const io = createWebPromptIO(s);

    const answer = io.askChoice(
      "Pick one",
      [
        { label: "React", description: "library" },
        { label: "Vue", description: "framework" },
      ],
      { multiple: true, allowCustom: false },
    );
    const id = onlyPendingId(s);
    const payload = events.join("");
    expect(payload).toContain('"kind":"choice"');
    expect(payload).toContain('"options":["React","Vue"]');
    expect(payload).toContain('"multiple":true');
    expect(payload).toContain('"allowCustom":false');

    resolveAnswer(s, id, [1]);
    await expect(answer).resolves.toEqual([1]);
  });

  it("resolveAnswer returns false for an unknown id", () => {
    const s = createWebUiState();
    expect(resolveAnswer(s, "nope", "x")).toBe(false);
  });

  it("cancelPendingQuestions settles every pending question", async () => {
    const s = createWebUiState();
    const io = createWebPromptIO(s);
    const text = io.askText("Q1");
    const choice = io.askChoice("Q2", [{ label: "A", description: "a" }]);
    expect(s.pendingQuestions.size).toBe(2);

    cancelPendingQuestions(s);
    await expect(text).resolves.toBe("");
    await expect(choice).resolves.toEqual([]);
    expect(s.pendingQuestions.size).toBe(0);
  });
});

describe("POST /api/answer", () => {
  afterEach(() => stopServer());

  function post(base: string, body: string, headers: Record<string, string> = {}) {
    return doFetch(`${base}/api/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
  }

  it("200 resolves a pending question", async () => {
    const s = createWebUiState();
    const io = createWebPromptIO(s);
    const answer = io.askText("hi");
    const id = onlyPendingId(s);

    await withServer(s, async (base) => {
      const res = await post(base, JSON.stringify({ id, value: "hello" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
    await expect(answer).resolves.toBe("hello");
  });

  it("404 for an unknown id", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const res = await post(base, JSON.stringify({ id: "ghost", value: "x" }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown id" });
    });
  });

  it("400 for a malformed body", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const bad = await post(base, "{not json");
      expect(bad.status).toBe(400);
      const missing = await post(base, JSON.stringify({ value: "x" }));
      expect(missing.status).toBe(400);
    });
  });

  it("401 without a token when one is configured", async () => {
    const s = createWebUiState();
    s.token = "s3cret";
    await withServer(s, async (base) => {
      const res = await post(base, JSON.stringify({ id: "x", value: 1 }));
      expect(res.status).toBe(401);
    });
  });
});
