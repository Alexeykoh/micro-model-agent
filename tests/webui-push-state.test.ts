import { describe, it, expect, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { createWebUiState } from "../src/modules/webui/state";
import { pushState } from "../src/modules/webui/session/session-status";
import { handleSessionDelete, handleSessionDeactivate } from "../src/modules/webui/session/sessions-api";

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

  it("stamps an unscoped snapshot with the server-active session", () => {
    const s = createWebUiState();
    const { chunks, res } = capture();
    s.clients.add(res);
    s.bridge = { getState: () => ({}) } as never;
    s.activeSessionId = "S";
    pushState(s);
    // Без явного id ставим серверно-активную сессию: иначе снапшот одной
    // сессии переписывал состояние чужой вкладки (аудит §6.12).
    expect(chunks.join("")).toContain('"sessionId":"S"');
  });

  it("sends a sessionless snapshot when there is no active session", () => {
    const s = createWebUiState();
    const { chunks, res } = capture();
    s.clients.add(res);
    s.bridge = { getState: () => ({}) } as never;
    pushState(s);
    expect(chunks.join("")).not.toContain('"sessionId"');
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

describe("session deactivate (last tab closed)", () => {
  it("clears active, resets the plan tracker and drops the idle runner", () => {
    const s = createWebUiState();
    const { chunks, res } = capture();
    s.clients.add(res);
    s.bridge = { getState: () => null } as never;
    let active: string | null = "A";
    s.sessionManager = {
      list: () => [] as never,
      get: () => null,
      getActive: () => active,
      setActive: () => {},
      clearActive: () => {
        active = null;
      },
      delete: () => {},
    };
    const switchSession = vi.fn();
    s.execModule = { switchSession, forgetSession: vi.fn() };
    const drop = vi.spyOn(s.pool, "drop");

    handleSessionDeactivate(res, s);

    expect(active).toBeNull();
    expect(switchSession).toHaveBeenCalledWith(null);
    expect(drop).toHaveBeenCalledWith("A");
    // Full snapshot broadcast (sessionless) so other windows reset too.
    expect(chunks.join("")).toContain("event: state");
  });

  it("does not drop a busy runner", () => {
    const s = createWebUiState();
    const { res } = capture();
    s.sessionManager = {
      list: () => [] as never,
      get: () => null,
      getActive: () => "A",
      setActive: () => {},
      clearActive: () => {},
      delete: () => {},
    };
    s.pool.reserve("A");
    const drop = vi.spyOn(s.pool, "drop");

    handleSessionDeactivate(res, s);

    expect(drop).not.toHaveBeenCalled();
  });
});
