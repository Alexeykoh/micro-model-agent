// Regression guard for the file rows: a `read_file` call shows the line range
// it read, so two rows for the same file are distinguishable (same range vs a
// different slice). Before this, both rows looked identical.
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div id="msgs" class="msgs"></div>`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: {
    "tool.friendly.read_file": "Reading file",
    "tool.friendly.document_read": "Reading document",
    "web.tool.lines": "lines {from}–{to}",
    "web.tool.lines_from": "from line {from}",
    "web.tool.lines_title": "read range",
    "web.card.copy_title": "copy",
    "documents.read_blocks": "blocks {from}-{to}",
    "documents.read_section": "section “{title}”",
  },
};

const store = await import("../src/modules/webui/assets/js/store.js");
const turn = await import("../src/modules/webui/assets/js/feed/turn.js");

function mountTab(id: string): HTMLElement {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.body.appendChild(feed);
  store.tabs.tabs.push({ id, feed });
  return feed as HTMLElement;
}

const read = (id: string, offset?: number, limit?: number): void => {
  const args: Record<string, number> = {};
  if (offset !== undefined) args.offset = offset;
  if (limit !== undefined) args.limit = limit;
  turn.onToolStart({
    toolCallId: id,
    name: "read_file",
    args: { path: "docs/spec.md", ...args },
    sessionId: "S",
  });
  turn.onToolEnd({
    toolCallId: id,
    name: "read_file",
    success: true,
    durationMs: 3,
    output: "body",
    sessionId: "S",
  });
};

const docRead = (id: string, selector?: string): void => {
  const args: Record<string, string> = { path: "docs/spec.pdf" };
  if (selector !== undefined) args.selector = selector;
  turn.onToolStart({
    toolCallId: id,
    name: "document_read",
    args,
    sessionId: "S",
  });
  turn.onToolEnd({
    toolCallId: id,
    name: "document_read",
    success: true,
    durationMs: 3,
    output: "body",
    sessionId: "S",
  });
};

beforeEach(() => {
  store.tabs.tabs = [];
  store.tabs.activeTabId = null;
});

describe("read_file rows show the read range", () => {
  it("renders the inclusive line range from offset + limit", () => {
    const feed = mountTab("S");
    read("t1", 926, 70);
    expect(feed.textContent).toContain("docs/spec.md");
    expect(feed.textContent).toContain("lines 926–995");
  });

  it("keeps two reads of the same file distinguishable", () => {
    const feed = mountTab("S");
    read("t1", 380, 160);
    read("t2", 869, 100);
    const ranges = Array.from(feed.querySelectorAll(".filerow .range")).map((n) => n.textContent);
    expect(ranges).toEqual(["lines 380–539", "lines 869–968"]);
  });

  it("shows a limit-only read as starting at line 1 and a bare offset as 'from line'", () => {
    const feed = mountTab("S");
    read("t1", undefined, 45);
    read("t2", 120);
    const ranges = Array.from(feed.querySelectorAll(".filerow .range")).map((n) => n.textContent);
    expect(ranges).toEqual(["lines 1–45", "from line 120"]);
  });

  it("adds no range when the call read the default slice", () => {
    const feed = mountTab("S");
    read("t1");
    expect(feed.querySelector(".filerow")).not.toBeNull();
    expect(feed.querySelector(".filerow .range")).toBeNull();
  });
});

describe("document_read rows show the read slice", () => {
  it("renders the block range from the selector", () => {
    const feed = mountTab("S");
    docRead("d1", "blocks:10-25");
    expect(feed.textContent).toContain("docs/spec.pdf");
    expect(feed.textContent).toContain("blocks 10-25");
  });

  it("renders a section selector and keeps two reads distinguishable", () => {
    const feed = mountTab("S");
    docRead("d1", "section:A");
    docRead("d2", "section:B");
    const ranges = Array.from(feed.querySelectorAll(".filerow .range")).map((n) => n.textContent);
    expect(ranges).toEqual(["section “A”", "section “B”"]);
  });

  it("adds no range for a whole-document read", () => {
    const feed = mountTab("S");
    docRead("d1");
    docRead("d2", "all");
    expect(feed.querySelectorAll(".filerow")).toHaveLength(2);
    expect(feed.querySelector(".filerow .range")).toBeNull();
  });
});
