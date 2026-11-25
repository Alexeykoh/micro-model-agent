import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  buildRequest,
  formatResponse,
  resolveBaseURL,
  resolveToken,
} from "../../.opencode/plugins/projexify/api";

type Input = Parameters<typeof buildRequest>[0];

const base: Input = { action: "projects.list" };

describe("projexify plugin: action catalog", () => {
  it("covers all 24 documented endpoints", () => {
    expect(Object.keys(ACTIONS)).toHaveLength(24);
    expect(ACTIONS["tasks.restore"]).toBeDefined();
    expect(ACTIONS["time.stop"]).toBeDefined();
  });
});

describe("projexify plugin: request building", () => {
  it("builds GET /projects without ids", () => {
    expect(buildRequest(base)).toEqual({ method: "GET", path: "/projects" });
  });

  it("sends only allowed create fields and drops unknown ones", () => {
    expect(
      buildRequest({
        action: "tasks.create",
        projectId: "p1",
        params: {
          title: "Новая задача",
          priority: "HIGH",
          dueDate: "2026-12-01T00:00:00Z",
          bogus: "drop me",
        },
      }),
    ).toEqual({
      method: "POST",
      path: "/projects/p1/tasks",
      body: { title: "Новая задача", priority: "HIGH", dueDate: "2026-12-01T00:00:00Z" },
    });
  });

  it("encodes ids in the path and does not send a body for assign", () => {
    expect(
      buildRequest({ action: "tasks.assign", projectId: "p/1", taskId: "t 1", targetId: "u/2" }),
    ).toEqual({
      method: "POST",
      path: "/projects/p%2F1/tasks/t%201/assignees/u%2F2",
    });
  });

  it("builds a filtered task list with encoded query values", () => {
    expect(
      buildRequest({
        action: "tasks.list",
        projectId: "p1",
        params: { q: "поиск任务", priority: "HIGH", limit: 10, bogus: "drop me" },
      }),
    ).toEqual({
      method: "GET",
      path: "/projects/p1/tasks",
      query: "q=%D0%BF%D0%BE%D0%B8%D1%81%D0%BA%E4%BB%BB%E5%8A%A1&priority=HIGH&limit=10",
    });
  });

  it("sends a status change as a PATCH with statusId", () => {
    expect(
      buildRequest({
        action: "tasks.setStatus",
        projectId: "p1",
        taskId: "t1",
        params: { statusId: "s2" },
      }),
    ).toEqual({ method: "PATCH", path: "/projects/p1/tasks/t1/status", body: { statusId: "s2" } });
  });

  it("rejects a status change without statusId", () => {
    expect(() =>
      buildRequest({ action: "tasks.setStatus", projectId: "p1", taskId: "t1" }),
    ).toThrow(/statusId/);
  });

  it("rejects missing path ids with a clear message", () => {
    expect(() => buildRequest({ action: "tasks.get", projectId: "p1" })).toThrow(/taskId/);
    expect(() => buildRequest({ action: "tasks.get", taskId: "t1" })).toThrow(/projectId/);
  });

  it("validates the link type", () => {
    expect(() =>
      buildRequest({
        action: "links.add",
        projectId: "p1",
        taskId: "t1",
        params: { toTaskId: "t2", type: "DEPENDS_ON" },
      }),
    ).toThrow(/BLOCKS|BLOCKED_BY/);
  });

  it("maps targetId to checklist item id and keeps checked as a boolean", () => {
    expect(
      buildRequest({
        action: "checklist.update",
        projectId: "p1",
        taskId: "t1",
        targetId: "i1",
        params: { title: "проверено", checked: true },
      }),
    ).toEqual({
      method: "PATCH",
      path: "/projects/p1/tasks/t1/checklist/i1",
      body: { title: "проверено", checked: true },
    });
  });

  it("rejects an unknown action", () => {
    expect(() => buildRequest({ action: "tasks.fly" })).toThrow(/Unknown action/);
  });
});

describe("projexify plugin: response formatting", () => {
  it("explains 401 and never echoes the token", () => {
    const out = formatResponse(
      401,
      JSON.stringify({ message: "bad token pxt_SECRET" }),
      "pxt_SECRET",
    );
    expect(out).toContain("401");
    expect(out).toContain("[redacted]");
    expect(out).not.toContain("pxt_SECRET");
  });

  it("hints at project binding on 403 and status transitions on 409", () => {
    expect(formatResponse(403, "denied", "pxt_SECRET123")).toContain("привязан");
    expect(formatResponse(409, "conflict", "pxt_SECRET123")).toContain("переходов");
  });

  it("keeps successful JSON and marks an empty body as ok", () => {
    expect(formatResponse(200, '{"id":"t1"}', "pxt_SECRET123")).toBe('{"id":"t1"}');
    expect(formatResponse(204, "", "pxt_SECRET123")).toBe('{"ok":true}');
  });

  it("truncates oversized output with a marker", () => {
    const out = formatResponse(200, "x".repeat(20000), "t");
    expect(out.length).toBeLessThan(20000);
    expect(out).toContain("truncated");
  });
});

describe("projexify plugin: configuration", () => {
  it("appends the external API path to a bare origin", () => {
    expect(resolveBaseURL("http://localhost:80")).toBe("http://localhost:80/api/v1/external");
    expect(resolveBaseURL("http://localhost:80/api/v1/external/")).toBe(
      "http://localhost:80/api/v1/external",
    );
  });

  it("prefers options over env over local token file", () => {
    expect(resolveToken({ token: "from-options" }, { PROJEXIFY_TOKEN: "from-env" }, "from-file")).toBe(
      "from-options",
    );
    expect(resolveToken({}, { PROJEXIFY_TOKEN: "from-env" }, "from-file")).toBe("from-env");
    expect(resolveToken({}, {}, "from-file")).toBe("from-file");
    expect(resolveToken({}, {}, "")).toBe("");
  });
});
