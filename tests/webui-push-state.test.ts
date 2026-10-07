import { describe, it, expect } from "vitest";
import type { ServerResponse } from "node:http";
import { createWebUiState } from "../src/modules/webui/state";
import { pushState } from "../src/modules/webui/session/session-status";
import { handleSessionDelete } from "../src/modules/webui/session/sessions-api";

function capture(): { chunks: string[]; res: ServerResponse } {
  const chunks: string[] = [];
  const res = {
    write: (c: string) => {
      chunks.push(c);
      return true;
    },
    end: () => {},
    writeHead: () => res,
    setHeader: () => res,
  } as unknown as ServerResponse;
  return { chunks, res };
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

  it("sends a sessionless snapshot without a sessionId", () => {
    const s = createWebUiState();
    const { chunks, res } = capture();
    s.clients.add(res);
    s.bridge = { getState: () => ({}) } as never;
    pushState(s);
    expect(chunks.join("")).not.toContain('"sessionId":"S"');
  });
});

describe("sessions SSE event", () => {
  it("emits a sessions event on delete", () => {
    const s = createWebUiState();
    const { chunks, res } = capture();
    s.clients.add(res);
    s.sessionManager = {
      list: () => [{ id: "B", name: "B" }] as never,
      get: () => ({ id: "B" }) as never,
      getActive: () => "A",
      setActive: () => {},
      delete: () => {},
    };

    handleSessionDelete(res, "B", s);
    expect(chunks.join("")).toContain("event: sessions");
    expect(chunks.join("")).toContain('"id":"B"');
  });
});
