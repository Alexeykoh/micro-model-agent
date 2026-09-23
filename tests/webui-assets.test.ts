import { describe, it, expect } from "vitest";
import { loadAssets } from "../src/modules/webui/assets";

describe("webui assets", () => {
  it("loads html/css/js from disk", () => {
    const a = loadAssets();
    expect(a.html).toContain("<!DOCTYPE html>");
    expect(a.css.length).toBeGreaterThan(10);
    expect(a.js).toContain("EventSource");
  });

  // No DOM harness is available in the unit test env, so this is a source-level
  // guard: the feed renders the plan card from a dedicated SSE `plan` event.
  it("wires the plan event to the .planblock feed card", () => {
    const a = loadAssets();
    expect(a.js).toContain('addEventListener("plan"');
    expect(a.js).toContain("planblock");
    expect(a.css).toContain(".planblock");
  });

  it("wires the question event to an interactive .q block posting /api/answer", () => {
    const a = loadAssets();
    expect(a.js).toContain('addEventListener("question"');
    expect(a.js).toContain("/api/answer");
    expect(a.js).toContain("qopt");
    expect(a.css).toContain(".q .qopt");
  });
});
