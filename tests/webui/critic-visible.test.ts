// Критик в чате полностью свёрнут: видна только строка шапки, всё остальное —
// под общим `.think-h`-тогглом. Раскрывается по клику, как размышления.
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
    "web.action.show": "show",
    "web.action.hide": "hide",
  };
}

i18n.I18N.locale = "en";
i18n.I18N.dicts = { en: criticDict() };

const store = await import("../../src/modules/webui/assets/js/store.js");
const { onCritic } = await import("../../src/modules/webui/assets/js/feed/critic-block.js");
const { toggleThinkHead } = await import("../../src/modules/webui/assets/js/feed/stream.js");

function mountTab(id: string): HTMLElement {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.getElementById("msgs")!.appendChild(feed);
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

describe("critic verdict in chat: collapsed by default", () => {
  it("shows only the header line and keeps the whole verdict hidden", () => {
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
    const head = block!.querySelector<HTMLElement>("button.think-h");
    expect(head).not.toBeNull();
    expect(head!.getAttribute("aria-expanded")).toBe("false");
    expect(head!.querySelector(".tog")).toBeTruthy();
    expect(head!.textContent).toContain("concern");
    // Всё содержимое лежит в скрытом теле: в ленте видна только шапка.
    const body = block!.querySelector<HTMLElement>(".critic-body");
    expect(body).not.toBeNull();
    expect(body!.classList.contains("hidden")).toBe(true);
    expect(body!.textContent).toContain("Build is broken");
    expect(body!.textContent).toContain("Module not found: better-sqlite3");
    expect(body!.textContent).toContain("install the dependency");
    expect(body!.textContent).toContain("bun run build");
    expect(body!.querySelector(".critic-check-tool")?.textContent).toBe("bash");
  });

  it("opens and closes the whole body from the header toggle", () => {
    const feed = mountTab("S2");
    onCritic({ status: "ok", passes: 1, durationMs: 900 }, "S2");
    const head = feed.querySelector<HTMLElement>(".critic-block .think-h")!;
    const body = feed.querySelector<HTMLElement>(".critic-block .critic-body")!;
    expect(body.classList.contains("hidden")).toBe(true);

    // Прямой вызов той же логики, что и delegated-клик (#msgs подменяется
    // между тестовыми файлами, слушатель может остаться на старом document).
    toggleThinkHead(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(body.classList.contains("hidden")).toBe(false);

    toggleThinkHead(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(body.classList.contains("hidden")).toBe(true);
  });

  it("renders the empty verdict line inside the collapsed body", () => {
    const feed = mountTab("S3");
    onCritic({ status: "ok", passes: 1, durationMs: 900 }, "S3");
    const body = feed.querySelector<HTMLElement>(".critic-block .critic-body");
    expect(body).not.toBeNull();
    expect(body!.classList.contains("hidden")).toBe(true);
    expect(body!.textContent).toContain("no issues — nothing to fix");
  });
});
