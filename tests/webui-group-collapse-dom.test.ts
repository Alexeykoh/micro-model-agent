// DOM coverage for collapsible agent steps: live runs fold into one Lucide
// summary row after the turn, history folds the same way, and the original
// rows stay reachable through expand/collapse (no re-render, no data loss).
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

setupHappyDom(`<div id="msgs" class="msgs"><div class="feed" id="feed"></div></div>`);

const { I18N } = await import("../src/modules/webui/assets/js/i18n.js");
const { settings } = await import("../src/modules/webui/assets/js/store.js");
const { foldRun, foldHistory, buildGroupSummary, trackNode, syncStepFolding } = await import(
  "../src/modules/webui/assets/js/feed/activity-group.js"
);

I18N.locale = "en";
I18N.dicts = {
  en: {
    "web.group.label": "agent steps",
    "web.group.failures_one": "{count} error",
    "web.group.failures_few": "{count} errors",
    "web.group.failures_many": "{count} errors",
    "web.group.warnings_one": "{count} warning",
    "web.group.warnings_few": "{count} warnings",
    "web.group.warnings_many": "{count} warnings",
    "web.group.thoughts_one": "{count} thought",
    "web.group.thoughts_few": "{count} thoughts",
    "web.group.thoughts_many": "{count} thoughts",
    "web.group.reads_one": "{count} read",
    "web.group.reads_few": "{count} reads",
    "web.group.reads_many": "{count} reads",
    "web.group.commands_one": "{count} command",
    "web.group.commands_few": "{count} commands",
    "web.group.commands_many": "{count} commands",
    "web.turn.tools_one": "{count} tool",
    "web.turn.tools": "{count} tools",
    "web.action.show": "show",
    "web.action.hide": "hide",
  },
};

const feed = (): HTMLElement => document.getElementById("feed") as HTMLElement;
const el = (cls: string): HTMLElement => {
  const node = document.createElement("div");
  node.className = cls;
  return node;
};

function act(cls: string, status = "", fail = false): HTMLElement {
  const node = el(`act ${cls}`);
  const ok = document.createElement("span");
  ok.className = `ok${fail ? " fail" : ""}`;
  ok.textContent = status;
  node.appendChild(ok);
  return node;
}

function reset(): void {
  settings.config = {};
  feed().replaceChildren();
}

describe("agent step groups", () => {
  it("builds a one-line summary with Lucide icons and localized counts", () => {
    const row = buildGroupSummary(
      { failures: 1, warnings: 0, thoughts: 2, reads: 2, edits: 0, commands: 1, tools: 0 },
      1500,
    );
    expect(row.tagName).toBe("BUTTON");
    expect(row.className).toBe("group-sum");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.querySelector(".g svg")).toBeTruthy();
    expect(row.querySelector(".tog svg")).toBeTruthy();
    expect(row.querySelectorAll(".part svg").length).toBe(4);
    expect(row.querySelector(".part-failures svg")).toBeTruthy();
    expect(row.querySelector(".part-thoughts svg")).toBeTruthy();
    expect(row.querySelector(".part-reads svg")).toBeTruthy();
    expect(row.querySelector(".part-commands svg")).toBeTruthy();
    expect(row.querySelector(".parts")?.textContent).toBe(
      "1 error · 2 thoughts · 2 reads · 1 command",
    );
  });

  it("folds a live run at its DOM position and keeps the original rows", () => {
    reset();
    const think = el("think");
    const read = act("act recon", " ✓ 925ms");
    const run = act("act execute", " ✗ 1.2s", true);
    for (const node of [think, read, run]) {
      feed().appendChild(node);
      trackNode(feed(), node);
    }

    foldRun(feed());

    const summary = feed().querySelector(".group-sum") as HTMLElement;
    const detail = feed().querySelector(".group-detail") as HTMLElement;
    expect(summary).toBeTruthy();
    expect(detail).toBeTruthy();
    expect(detail.classList.contains("hidden")).toBe(true);
    expect(detail.contains(think)).toBe(true);
    expect(detail.contains(read)).toBe(true);
    expect(detail.contains(run)).toBe(true);
    expect(feed().firstElementChild).toBe(summary);
    expect(summary.nextElementSibling).toBe(detail);
  });

  it("expands and collapses in place via delegated click", () => {
    reset();
    feed().appendChild(el("think"));
    trackNode(feed(), feed().firstElementChild as HTMLElement);
    foldRun(feed());

    const summary = feed().querySelector(".group-sum") as HTMLElement;
    const detail = feed().querySelector(".group-detail") as HTMLElement;
    summary.click();
    expect(detail.classList.contains("hidden")).toBe(false);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    summary.click();
    expect(detail.classList.contains("hidden")).toBe(true);
    expect(summary.getAttribute("aria-expanded")).toBe("false");
  });

  it("folds separate history runs but never user or answer blocks", () => {
    reset();
    const nodes = [
      el("think"),
      el("act recon"),
      el("u"),
      el("act mutate"),
      el("act execute"),
      el("md"),
    ];
    for (const node of nodes) feed().appendChild(node);

    foldHistory(feed());

    expect(feed().querySelectorAll(".group-sum").length).toBe(2);
    expect(feed().querySelector(".u")).toBeTruthy();
    expect(feed().querySelector(".md")).toBeTruthy();
    expect(feed().querySelectorAll(".group-detail > .act").length).toBe(3);
  });

  it("keeps every row visible in verbose mode", () => {
    reset();
    settings.config = { ui: { verbosity: "verbose" } };
    feed().appendChild(el("think"));
    trackNode(feed(), feed().firstElementChild as HTMLElement);
    foldRun(feed());
    expect(feed().querySelector(".group-sum")).toBeNull();
    expect(feed().querySelector(".think")).toBeTruthy();
  });

  it("respects the ui.collapseSteps option", () => {
    reset();
    settings.config = { ui: { collapseSteps: false } };
    for (const node of [el("think"), el("act recon")]) {
      feed().appendChild(node);
      trackNode(feed(), node);
    }
    foldRun(feed());
    expect(feed().querySelector(".group-sum")).toBeNull();
    expect(feed().querySelectorAll(".think, .act").length).toBe(2);
  });

  it("keeps one summary across tool errors instead of splitting the run", () => {
    reset();
    const err = el("errline fail");
    err.textContent = "✗ Ошибка загрузки: timeout";
    for (const node of [el("think"), el("act recon"), err, el("act recon")]) {
      feed().appendChild(node);
      trackNode(feed(), node);
    }
    foldRun(feed());
    expect(feed().querySelectorAll(".group-sum").length).toBe(1);
    expect(feed().querySelectorAll(".group-detail > *").length).toBe(4);
    expect(feed().querySelector(".group-sum .parts")?.textContent).toContain("1 error");
  });

  it("never nests a group inside another group's detail", () => {
    reset();
    const think = el("think");
    feed().appendChild(think);
    trackNode(feed(), think);
    // Simulate the same row reaching the grouping hook a second time.
    trackNode(feed(), think);
    expect(feed().querySelector(".group-detail .group-sum")).toBeNull();
    expect(feed().querySelectorAll(".group-sum").length).toBe(1);

    // Old sessions may already contain nested groups — history replay lifts them.
    const outer = feed().querySelector(".group-detail") as HTMLElement;
    const innerSum = el("group-sum");
    const innerDetail = el("group-detail");
    outer.appendChild(innerSum);
    outer.appendChild(innerDetail);
    foldHistory(feed());
    expect(feed().querySelector(".group-detail .group-sum")).toBeNull();
  });

  it("counts plain error lines as failures, not tools, and warnings separately", () => {
    reset();
    const err = el("errline");
    err.textContent = "✗ boom";
    const warn = el("warnline");
    warn.textContent = "⚠ careful";
    for (const node of [el("act recon"), err, warn]) {
      feed().appendChild(node);
      trackNode(feed(), node);
    }
    foldRun(feed());
    const sum = feed().querySelector(".group-sum") as HTMLElement;
    expect(sum.querySelector(".parts")?.textContent).toBe("1 error · 1 warning · 1 read");
    expect(sum.querySelector(".part-failures svg")).toBeTruthy();
    expect(sum.querySelector(".part-warnings svg")).toBeTruthy();
  });

  it("unfolds existing rows when the option is turned off at runtime", () => {
    reset();
    for (const node of [el("think"), el("act recon")]) {
      feed().appendChild(node);
      trackNode(feed(), node);
    }
    foldRun(feed());
    expect(feed().querySelector(".group-sum")).toBeTruthy();

    settings.config = { ui: { collapseSteps: false } };
    syncStepFolding();
    expect(feed().querySelector(".group-sum")).toBeNull();
    expect(feed().querySelectorAll(".think, .act").length).toBe(2);

    settings.config = { ui: { collapseSteps: true } };
    syncStepFolding();
    expect(feed().querySelectorAll(".group-sum").length).toBe(1);
  });

  it("keeps retract/critic notices and subagent rows outside the fold", () => {
    reset();
    const nodes = [
      el("act recon"),
      el("think retract-block"),
      el("act recon"),
      el("act recon"),
      el("act recon"),
    ];
    nodes[3].dataset.toolCallId = "sub1";
    for (const node of nodes) feed().appendChild(node);
    foldHistory(feed());
    expect(feed().querySelector(".retract-block")).toBeTruthy();
    expect(feed().querySelector('[data-tool-call-id="sub1"]')).toBeTruthy();
    expect(feed().querySelectorAll(".group-sum").length).toBe(3);
  });

  it("leaves no empty '+' group when a transient status line is removed", () => {
    reset();
    const status = el("metaln status");
    feed().appendChild(status);
    trackNode(feed(), status);
    expect(feed().querySelector(".group-sum")).toBeNull();

    const read = el("act recon");
    feed().appendChild(read);
    trackNode(feed(), read);
    const detail = feed().querySelector(".group-detail") as HTMLElement;
    expect(detail.contains(status)).toBe(false);
    expect(detail.contains(read)).toBe(true);

    // clearStatusLines() before the critic report removes the status row;
    // the step group must stay real, not become an empty "+" summary.
    status.remove();
    expect(feed().querySelectorAll(".group-sum").length).toBe(1);
    expect(detail.children.length).toBe(1);
  });
});
