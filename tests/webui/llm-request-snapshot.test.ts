import { describe, expect, it, vi } from "vitest";
import { captureRequestSnapshot } from "../../src/llm/request-snapshot";
import {
  installRequestForwarding,
  type RequestForwardState,
} from "../../src/modules/webui/session/request-forward";

function fakeState(writes: string[]): { state: RequestForwardState; appendLog: ReturnType<typeof vi.fn> } {
  const appendLog = vi.fn();
  const client = {
    write: (chunk: string): boolean => {
      writes.push(chunk);
      return true;
    },
    end: (): void => {},
  };
  const state = {
    clients: new Set([client]),
    pool: { getRunner: () => ({ sessionManager: { appendLog } }) },
  } as unknown as RequestForwardState;
  return { state, appendLog };
}

const body = {
  messages: [{ role: "user", content: "hello" }],
  tools: [],
  max_tokens: 64,
};

describe("мост снимка запроса → SSE + журнал (U20)", () => {
  it("пишет llm_request раннеру-владельцу и отдаёт SSE", () => {
    const writes: string[] = [];
    const { state, appendLog } = fakeState(writes);
    const off = installRequestForwarding(state);
    captureRequestSnapshot(body, {
      model: "m",
      baseUrl: "https://api.example.com/v1",
      stream: true,
      sessionId: "s1",
    });
    off();

    expect(appendLog).toHaveBeenCalledTimes(1);
    const [entry, id] = appendLog.mock.calls[0];
    expect(id).toBe("s1");
    expect(entry).toMatchObject({ type: "llm_request", source: "core" });
    expect(entry.llmRequest).toMatchObject({ model: "m", providerHost: "api.example.com" });

    const sse = writes.join("");
    expect(sse).toContain("event: llm_request");
    expect(sse).toContain('"sessionId":"s1"');
  });

  it("без sessionId не пишет журнал, но событие всё равно уходит", () => {
    const writes: string[] = [];
    const { state, appendLog } = fakeState(writes);
    const off = installRequestForwarding(state);
    captureRequestSnapshot(body, { model: "m", stream: false });
    off();
    expect(appendLog).not.toHaveBeenCalled();
    expect(writes.join("")).toContain("event: llm_request");
  });

  it("отписка прекращает поток", () => {
    const writes: string[] = [];
    const { state } = fakeState(writes);
    const off = installRequestForwarding(state);
    off();
    captureRequestSnapshot(body, { model: "m", stream: true, sessionId: "s1" });
    expect(writes).toHaveLength(0);
  });
});
