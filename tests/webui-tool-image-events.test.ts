import { describe, it, expect } from "vitest";
import { createWebUiState } from "../src/modules/webui/state";
import { makeForwarder } from "../src/modules/webui/session/forward";
import { normalizeHistory } from "../src/modules/webui/session/history-api";
import type { SessionLogEntry } from "../src/modules/session/store";
import type { ToolResult } from "../src/tools/types";
import type { SseEvent } from "../src/modules/webui/state";

const REF = { file: "1728300000000-ab12cd.png", mime: "image/png", bytes: 5 };

function forwarder(events: SseEvent[], owner: string | null) {
  return makeForwarder(createWebUiState(), (ev) => events.push(ev), {
    ownerRef: { current: owner },
  });
}

function endTool(result: ToolResult, owner: string | null): SseEvent[] {
  const events: SseEvent[] = [];
  const fwd = forwarder(events, owner);
  fwd.onToolEnd({ id: "t1", name: "browser", arguments: { action: "screenshot" } }, result, 10);
  return events;
}

describe("tool_end image delivery over SSE", () => {
  it("maps persisted refs to session image URLs", () => {
    const events = endTool({ success: true, output: "shot", imageRefs: [REF] }, "ses_abc");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_end");
    expect(events[0].images).toEqual(["/api/sessions/ses_abc/images/1728300000000-ab12cd.png"]);
  });

  it("falls back to inline data URLs when nothing was persisted", () => {
    const part = { type: "image_url" as const, image_url: { url: "data:image/png;base64,AA==" } };
    const events = endTool({ success: true, output: "shot", images: [part] }, "ses_abc");
    expect(events[0].images).toEqual(["data:image/png;base64,AA=="]);
  });

  it("omits images for text-only results and without an owner", () => {
    expect(endTool({ success: true, output: "plain" }, "ses_abc")[0].images).toBeUndefined();
    expect(endTool({ success: true, output: "shot", imageRefs: [REF] }, null)[0].images).toBeUndefined();
  });
});

describe("history replay of tool images", () => {
  const LOG: SessionLogEntry[] = [
    {
      ts: "2026-10-07T10:00:00.000Z",
      type: "tool_result",
      tool: "browser",
      tool_call_id: "c1",
      success: true,
      images: [REF],
    },
    {
      ts: "2026-10-07T10:00:01.000Z",
      type: "tool_result",
      tool: "bash",
      tool_call_id: "c2",
      success: true,
    },
  ];

  it("maps refs to session image URLs keyed by session id", () => {
    const out = normalizeHistory(LOG, 0, [], "ses_xyz");
    expect(out[0].kind).toBe("tool_result");
    expect(out[0].images).toEqual(["/api/sessions/ses_xyz/images/1728300000000-ab12cd.png"]);
    expect(out[1].images).toBeUndefined();
  });

  it("keeps entries image-less when session id is unknown", () => {
    const out = normalizeHistory(LOG, 0, []);
    expect(out[0].images).toBeUndefined();
  });
});
