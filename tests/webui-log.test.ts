import { describe, it, expect } from "vitest";
import { createWebUiState } from "../src/modules/webui/state";
import { tailSessionLog } from "../src/modules/webui/session/log-api";
import type { SessionLogEntry } from "../src/modules/session/store";
import { withServer, doFetch } from "./helpers/webui-server";

const entry = (type: SessionLogEntry["type"], ts: string, extra: Record<string, unknown> = {}) =>
  ({ ts, type, ...extra }) as SessionLogEntry;

const LOG: SessionLogEntry[] = [
  entry("user", "2026-10-01T10:00:00.000Z", { content: "hi" }),
  entry("assistant", "2026-10-01T10:00:01.000Z", { content: "hello", iteration: 1 }),
  entry("tool_defs", "2026-10-01T10:00:02.000Z", { content: " Pint 40 tools" }),
  entry("llm_usage", "2026-10-01T10:00:03.000Z", {
    iteration: 1,
    provider: "lm studio",
    model: "qwen/qwen3.5-9b",
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
  }),
  entry("claim_retry", "2026-10-01T10:00:04.000Z", {
    kind: "success",
    iteration: 2,
    content: "Ответ заявляет об успехе, но свежий результат тула указывает на проблему (plan: boom)",
  }),
  entry("critic_verdict", "2026-10-01T10:00:05.000Z", { status: "concern", content: "looks thin" }),
  entry("compaction", "2026-10-01T10:00:06.000Z", { content: "compacted" }),
];

describe("tailSessionLog", () => {
  it("returns the diagnostic set by default, dropping chat-internal types", () => {
    const out = tailSessionLog(LOG);
    expect(out.map((e) => e.type)).toEqual([
      "assistant",
      "llm_usage",
      "claim_retry",
      "critic_verdict",
      "compaction",
    ]);
  });

  it("filters by types and honors since + limit", () => {
    const out = tailSessionLog(LOG, {
      types: ["claim_retry", "critic_verdict"],
      since: "2026-10-01T10:00:04.000Z",
      limit: 10,
    });
    expect(out.map((e) => e.type)).toEqual(["critic_verdict"]);
  });

  it("ignores unknown types (fail-open to empty, never leaks)", () => {
    expect(tailSessionLog(LOG, { types: ["nope"] })).toEqual([]);
    expect(tailSessionLog(LOG, { limit: 2 }).map((e) => e.type)).toEqual([
      "critic_verdict",
      "compaction",
    ]);
    expect(tailSessionLog(LOG, { limit: 10_000 })).toHaveLength(5);
  });

  it("picks whitelisted fields and scrubs content", () => {
    const out = tailSessionLog(LOG, { types: ["llm_usage", "claim_retry"] });
    expect(out[0]).toMatchObject({
      type: "llm_usage",
      iteration: 1,
      provider: "lm studio",
      model: "qwen/qwen3.5-9b",
      totalTokens: 120,
    });
    expect(out[0]).not.toHaveProperty("args");
    expect(out[1]).toMatchObject({ type: "claim_retry", kind: "success", iteration: 2 });
  });
});

function managerWith(log: SessionLogEntry[]) {
  return {
    get: (id: string) => (id === "s1" ? { id } : undefined),
    loadSessionLog: (_id: string) => log,
  };
}

describe("handleSessionLog route", () => {
  it("503 without a session manager, 404 for unknown ids", async () => {
    const bare = createWebUiState();
    await withServer(bare, async (base) => {
      expect((await doFetch(`${base}/api/sessions/s1/log`)).status).toBe(503);
    });
    const s = createWebUiState();
    s.sessionManager = managerWith(LOG) as unknown as typeof s.sessionManager;
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/sessions/nope/log`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    });
  });

  it("serves the filtered tail as JSON", async () => {
    const s = createWebUiState();
    s.sessionManager = managerWith(LOG) as unknown as typeof s.sessionManager;
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/sessions/s1/log?types=claim_retry,critic_verdict`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; log: Array<{ type: string }> };
      expect(body.id).toBe("s1");
      expect(body.log.map((e) => e.type)).toEqual(["claim_retry", "critic_verdict"]);

      // Без query — весь диагностический сет, а не slice(-1):
      // Number(null) === 0 ломал дефолтный лимит.
      const plain = await doFetch(`${base}/api/sessions/s1/log`);
      expect(plain.status).toBe(200);
      const full = (await plain.json()) as { log: unknown[] };
      expect(full.log).toHaveLength(5);
    });
  });
});

describe("turn_end carries the server turn sequence", () => {
  it("onTurnEnd stamps turnSeq=1,2,…", async () => {
    const { makeForwarder } = await import("../src/modules/webui/session/forward");
    const s = createWebUiState();
    const seen: Array<{ type: string; turnSeq?: number }> = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev as { type: string; turnSeq?: number }));
    fwd.onTurnEnd({ success: true });
    fwd.onTurnEnd({ success: false });
    expect(seen.map((e) => e.turnSeq)).toEqual([1, 2]);
  });
});
