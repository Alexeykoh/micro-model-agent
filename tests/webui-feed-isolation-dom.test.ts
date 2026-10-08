// Regression guard: with parallel turns in two tabs, a background session's
// stream/tool events must never land in the active tab's feed (session id
// routing at the DOM layer). See `feed/stream.ts` / `core/store/feed.ts`.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div id="msgs" class="msgs"></div>`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = { en: {} };

const store = await import("../src/modules/webui/assets/js/store.js");
const stream = await import("../src/modules/webui/assets/js/feed/stream.js");
const turn = await import("../src/modules/webui/assets/js/feed/turn.js");

function mountTab(id: string): HTMLElement {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.body.appendChild(feed);
  store.tabs.tabs.push({ id, feed });
  return feed as HTMLElement;
}

describe("feed stream isolation across tabs", () => {
  it("routes interleaved streamed text to the owning session feed only", () => {
    const a = mountTab("A");
    const b = mountTab("B");
    stream.onText("alpha-XYZ ", "A");
    stream.onText("beta-ABC ", "B");
    stream.onText("alpha2", "A");
    stream.onText("beta2", "B");
    stream.finishMd(a);
    stream.finishMd(b);

    expect(a.textContent).toContain("alpha-XYZ");
    expect(a.textContent).toContain("alpha2");
    expect(a.textContent).not.toContain("beta-ABC");
    expect(a.textContent).not.toContain("beta2");
    expect(b.textContent).toContain("beta-ABC");
    expect(b.textContent).toContain("beta2");
    expect(b.textContent).not.toContain("alpha2");
  });

  it("keeps tool bookkeeping per feed even when toolCallIds collide", () => {
    const a = mountTab("A2");
    const b = mountTab("B2");
    // Both runners synthesize ids starting at `t1`; the per-feed maps must not
    // let B's `tool_end` resolve A's line (and vice versa).
    turn.onToolStart({ toolCallId: "t1", name: "bash", args: { command: "echo A" }, sessionId: "A2" });
    turn.onToolStart({ toolCallId: "t1", name: "bash", args: { command: "echo B" }, sessionId: "B2" });
    turn.onToolEnd({ toolCallId: "t1", name: "bash", success: true, durationMs: 5, output: "OUT-A", sessionId: "A2" });
    turn.onToolEnd({ toolCallId: "t1", name: "bash", success: true, durationMs: 5, output: "OUT-B", sessionId: "B2" });

    const lineA = a.querySelector(".act") as HTMLElement;
    const lineB = b.querySelector(".act") as HTMLElement;
    expect(lineA.classList.contains("running")).toBe(false);
    expect(lineB.classList.contains("running")).toBe(false);
    expect((lineA.querySelector(".ok") as HTMLElement).textContent).toContain("✓");
    expect((lineB.querySelector(".ok") as HTMLElement).textContent).toContain("✓");
  });
});
