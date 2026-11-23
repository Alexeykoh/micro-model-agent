// Intermediate answers must stay «bare»: the accent rail and translucent
// backdrop belong to the final answer of a turn only. Any text segment closed
// by a tool/reasoning/status/critic event is a draft, and used to regain the
// white/light bar on the left as soon as `finishMd()` removed `.streaming`.
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "../helpers/happy-dom";

const win = setupHappyDom(`<div id="msgs" class="msgs"></div>`);

const i18n = await import("../../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = { en: {} };

const store = await import("../../src/modules/webui/assets/js/store.js");
const stream = await import("../../src/modules/webui/assets/js/feed/stream.js");
const turn = await import("../../src/modules/webui/assets/js/feed/turn.js");

function mountTab(id: string): HTMLElement {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.body.appendChild(feed);
  store.tabs.tabs.push({ id, feed });
  return feed as HTMLElement;
}

describe("answer rail: only the final answer keeps it", () => {
  beforeEach(() => {
    store.tabs.tabs = [];
    win.document.body.textContent = "";
  });

  it("drops the rail from a draft closed by the next tool, keeps it on the final answer", () => {
    const feed = mountTab("RAIL1");

    stream.onText("intermediate answer", "RAIL1");
    const draft = feed.querySelector(".md") as HTMLElement;
    expect(draft.classList.contains("streaming")).toBe(true);
    expect(draft.classList.contains("interim")).toBe(false);

    // A tool starts in the same turn: the open text segment is a draft now.
    turn.onToolStart({
      sessionId: "RAIL1",
      toolCallId: "c1",
      name: "read_file",
      args: {},
    });
    expect(draft.classList.contains("streaming")).toBe(false);
    expect(draft.classList.contains("interim")).toBe(true);

    stream.onText("final answer", "RAIL1");
    const final = feed.querySelectorAll(".md")[1] as HTMLElement;
    expect(final.classList.contains("streaming")).toBe(true);

    turn.onTurnEnd({ sessionId: "RAIL1" });
    expect(final.classList.contains("streaming")).toBe(false);
    expect(final.classList.contains("interim")).toBe(false);
  });

  it("promotes the last answer back to final when a gate status closed it early", () => {
    const feed = mountTab("RAIL3");
    stream.onText("final answer", "RAIL3");
    // Gate status arrives after the answer text and closes the md segment.
    stream.onMeta("\n↳ checking the result…\n", "RAIL3", "status");
    const md = feed.querySelector(".md") as HTMLElement;
    expect(md.classList.contains("interim")).toBe(true);

    turn.onTurnEnd({ sessionId: "RAIL3" });
    expect(md.classList.contains("interim")).toBe(false);
  });

  it("keeps a retracted draft bare even though it was finalized by a gate status", () => {
    const feed = mountTab("RAIL2");
    stream.onText("draft to retract", "RAIL2");
    stream.onMeta("\n↳ checking the result…\n", "RAIL2", "status");
    const draft = feed.querySelector(".md") as HTMLElement;
    expect(draft.classList.contains("interim")).toBe(true);

    stream.onRetract("not delivered", "RAIL2", { source: "critic" });
    expect(feed.querySelector(".md")).toBeNull();
  });
});

describe("answer rail in history replay", () => {
  it("marks only the last assistant of each turn as final", async () => {
    const feed = mountTab("RAILH");
    const payload = {
      history: [
        { ts: "t1", kind: "user", text: "question" },
        { ts: "t2", kind: "assistant", text: "first draft" },
        { ts: "t3", kind: "tool_call", toolCallId: "c1", name: "read_file", args: {} },
        { ts: "t4", kind: "assistant", text: "final answer" },
        { ts: "t5", kind: "user", text: "next question" },
        { ts: "t6", kind: "assistant", text: "next final" },
      ],
    };
    (globalThis as Record<string, unknown>).fetch = async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const { loadHistory } = await import("../../src/modules/webui/assets/js/feed/history.js");
    await loadHistory({ id: "RAILH", feed } as never);

    const roots = feed.querySelectorAll(".md");
    expect(roots).toHaveLength(3);
    expect(roots[0].classList.contains("interim")).toBe(true);
    expect(roots[1].classList.contains("interim")).toBe(false);
    expect(roots[2].classList.contains("interim")).toBe(false);
  });
});
