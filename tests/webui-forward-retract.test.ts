import { describe, it, expect } from "vitest";
import { createWebUiState, type SseEvent } from "../src/modules/webui/state";
import { makeForwarder } from "../src/modules/webui/forward";

describe("webui forwarder retract", () => {
  it("emits a dedicated retract event, flushing buffered text first", () => {
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(createWebUiState(), (ev) => seen.push(ev));
    fwd.onText("partial-draft");
    fwd.onMeta("refining", "retract");
    expect(seen.map((e) => e.type)).toEqual(["text", "retract"]);
    expect(seen[0].chunk).toBe("partial-draft");
    expect(seen[1].reason).toBe("refining");
  });

  it("keeps retract out of the meta buffer (no duplicate meta event)", () => {
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(createWebUiState(), (ev) => seen.push(ev));
    fwd.onMeta("status-line");
    fwd.onMeta("refining", "retract");
    expect(seen.map((e) => e.type)).toEqual(["meta", "retract"]);
    expect(seen[0].chunk).toBe("status-line");
    expect(seen[1].reason).toBe("refining");
  });
});
