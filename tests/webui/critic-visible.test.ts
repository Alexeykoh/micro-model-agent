// Критику не нужно скрывать в чате: замечания критика видны сразу, без тоггла.
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "../helpers/happy-dom";

const win = setupHappyDom(`<div id="msgs" class="msgs"></div>`);

const i18n = await import("../../src/modules/webui/assets/js/i18n.js");

function criticDict(): Record<string, string> {
  return {
    "web.feed.critic_head": "verifier · {status} · {passes} pass(es) · {duration}",
    "web.feed.critic_status.ok": "ok",
    "web.feed.critic_status.concern": "concern",
    "web.feed.critic_status.critical": "critical",
    "web.feed.critic_status.none": "no verdict",
    "web.feed.critic_status_label": "verdict: {status}",
    "web.feed.critic_passes": "passes: {n}",
    "web.feed.critic_duration": "time: {time}",
    "web.feed.critic_timed_out": "cut off by the review budget",
    "web.feed.critic_issues": "what it flagged",
    "web.feed.critic_no_issues": "no issues — nothing to fix",
    "web.feed.critic_checks": "checks it ran",
  };
}

i18n.I18N.locale = "en";
i18n.I18N.dicts = { en: criticDict() };

const store = await import("../../src/modules/webui/assets/js/store.js");
const { onCritic } = await import("../../src/modules/webui/assets/js/feed/critic-block.js");

function mountTab(id: string): HTMLElement {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.body.appendChild(feed);
  store.tabs.tabs = [{ id, feed } as never];
  store.tabs.activeTabId = id;
  store.tabs.liveTabId = id;
  return feed as HTMLElement;
}

beforeEach(() => {
  // Другие тест-файлы в том же процессе перезаписывают глобальный словарь.
  i18n.I18N.locale = "en";
  i18n.I18N.dicts = { en: criticDict() };
  store.tabs.tabs = [];
  store.tabs.activeTabId = "";
  store.tabs.liveTabId = "";
});

describe("critic verdict in chat: always visible", () => {
  it("renders issues and checks inline, with no toggle and no hidden body", () => {
    const feed = mountTab("S1");
    onCritic(
      {
        status: "concern",
        passes: 2,
        durationMs: 12_500,
        summary: "Build is broken",
        issues: [
          {
            severity: "critical",
            claim: "build fails",
            problem: "Module not found: better-sqlite3",
            suggestion: "install the dependency",
          },
        ],
        checks: [{ ok: false, tool: "bash", args: "bun run build", output: "exit 1" }],
      },
      "S1",
    );

    const block = feed.querySelector<HTMLElement>(".critic-block");
    expect(block).not.toBeNull();
    // Свёрнутого блока больше нет: ни кнопки, ни тоггла, ни hidden-тела.
    expect(block!.querySelector(".think-h")).toBeNull();
    expect(block!.querySelector(".tog")).toBeNull();
    expect(block!.querySelector("[aria-expanded]")).toBeNull();
    const body = block!.querySelector<HTMLElement>(".think-body");
    expect(body).not.toBeNull();
    expect(body!.classList.contains("hidden")).toBe(false);
    // Замечания лежат в ленте и читаются без клика.
    expect(feed.textContent).toContain("Build is broken");
    expect(feed.textContent).toContain("Module not found: better-sqlite3");
    expect(feed.textContent).toContain("install the dependency");
    expect(feed.textContent).toContain("bun run build");
    expect(block!.querySelector(".critic-head")?.textContent).toContain("concern");
  });

  it("still shows the empty verdict line without any toggle", () => {
    const feed = mountTab("S2");
    onCritic({ status: "ok", passes: 1, durationMs: 900 }, "S2");
    const body = feed.querySelector<HTMLElement>(".critic-block .critic-body");
    expect(body).not.toBeNull();
    expect(body!.classList.contains("hidden")).toBe(false);
    expect(body!.textContent).toContain("no issues — nothing to fix");
    expect(feed.querySelector(".critic-block .think-h")).toBeNull();
  });
});
