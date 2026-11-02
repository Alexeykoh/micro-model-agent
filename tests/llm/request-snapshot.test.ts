import { afterEach, describe, expect, it } from "vitest";
import {
  buildRequestSnapshot,
  captureRequestSnapshot,
  resetRequestSnapshotSeq,
  subscribeRequestSnapshots,
  SNAPSHOT_LIMITS,
  type LlmRequestSnapshot,
} from "../../src/llm/request-snapshot";

const body = {
  model: "test-model",
  stream: true,
  messages: [
    { role: "system", content: "you are mma" },
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "tool", content: "tool output" },
  ],
  tools: [
    {
      type: "function",
      function: { name: "read_file", description: "reads a file", parameters: { type: "object" } },
    },
  ],
  max_tokens: 1024,
  reasoning_effort: "medium",
  tool_choice: "auto",
  stream_options: { include_usage: true },
};

const unsubs: Array<() => void> = [];

afterEach(() => {
  for (const off of unsubs.splice(0)) off();
  resetRequestSnapshotSeq();
});

describe("снимок исходящего запроса (U20)", () => {
  it("выделяет system отдельно и сохраняет порядок остальных сообщений", () => {
    const snap = buildRequestSnapshot(body, {
      model: "test-model",
      baseUrl: "https://api.openai.com/v1",
      stream: true,
      sessionId: "s1",
    });
    expect(snap.system).toContain("you are mma");
    expect(snap.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(snap.messages[1].text).toBe("hi");
    expect(snap.providerHost).toBe("api.openai.com");
    expect(snap.sessionId).toBe("s1");
    expect(snap.stream).toBe(true);
    expect(snap.truncated).toBe(false);
  });

  it("несёт параметры вызова и имена тулов без схем", () => {
    const snap = buildRequestSnapshot(body, { model: "test-model", stream: true });
    expect(snap.params.maxTokens).toBe(1024);
    expect(snap.params.reasoningEffort).toBe("medium");
    expect(snap.params.reasoning).toBe("medium");
    expect(snap.params.toolChoice).toBe("auto");
    expect(snap.params.streamUsage).toBe(true);
    expect(snap.tools).toEqual([{ name: "read_file", description: "reads a file" }]);
  });

  it("капает длинное сообщение и системный промпт", () => {
    const long = "x".repeat(SNAPSHOT_LIMITS.message + 50);
    const snap = buildRequestSnapshot(
      {
        messages: [
          { role: "system", content: "s".repeat(SNAPSHOT_LIMITS.system + 10) },
          { role: "user", content: long },
        ],
        tools: [],
      },
      { model: "m", stream: false },
    );
    expect(snap.messages[0].clipped).toBe(true);
    expect(snap.messages[0].text).toContain("truncated from");
    expect(snap.truncated).toBe(true);
  });

  it("не отдаёт token id: псевдоним DLP заменяется меткой класса", () => {
    const snap = buildRequestSnapshot(
      {
        messages: [
          { role: "system", content: "root <PATH:7788799a4d82> kept" },
          { role: "tool", content: "file <PATH:7788799a4d82>\\src\\a.ts and <HOST:abc>" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "read_file", description: "see <PATH:deadbeef>" },
          },
        ],
      },
      { model: "m", stream: true },
    );
    const text = JSON.stringify(snap);
    expect(text).not.toContain("7788799a4d82");
    expect(text).not.toContain("deadbeef");
    expect(text).toContain("‹PATH›");
    expect(text).toContain("‹HOST›");
  });

  it("не строит снимок без подписчиков и доставляет его подписчику", () => {
    const got: LlmRequestSnapshot[] = [];
    expect(captureRequestSnapshot(body, { model: "m", stream: true })).toBeUndefined();
    unsubs.push(subscribeRequestSnapshots((snap) => got.push(snap)));
    const snap = captureRequestSnapshot(body, { model: "m", stream: true });
    expect(snap).toBeDefined();
    expect(got).toHaveLength(1);
    expect(got[0].requestId).toMatch(/^req_/);
  });

  it("упавший подписчик не мешает остальным", () => {
    const got: LlmRequestSnapshot[] = [];
    unsubs.push(
      subscribeRequestSnapshots(() => {
        throw new Error("boom");
      }),
    );
    unsubs.push(subscribeRequestSnapshots((snap) => got.push(snap)));
    expect(() => captureRequestSnapshot(body, { model: "m", stream: true })).not.toThrow();
    expect(got).toHaveLength(1);
  });
});
