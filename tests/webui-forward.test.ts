import { describe, it, expect } from "vitest";
import { createWebUiState } from "../src/modules/webui/state";
import { makeForwarder } from "../src/modules/webui/forward";

describe("webui forwarder", () => {
  it("coalesces text chunks and emits on flush", () => {
    const s = createWebUiState();
    const seen: string[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev.type), { flushMs: 5 });
    fwd.onText("a");
    fwd.onText("b");
    fwd.flushNow();
    expect(seen).toContain("text");
  });

  it("maps tool start/end to events", () => {
    const s = createWebUiState();
    const seen: string[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev.type));
    fwd.onToolStart({ id: "1", name: "read_file", arguments: { path: "x" } });
    fwd.onToolEnd(
      { id: "1", name: "read_file", arguments: { path: "x" } },
      { success: true, output: "ok" },
      12,
    );
    expect(seen).toEqual(["tool_start", "tool_end"]);
  });
});
