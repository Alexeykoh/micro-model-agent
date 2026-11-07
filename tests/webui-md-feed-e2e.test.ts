// End-to-end регресс «чат не форматируется в Markdown» (TODO §1.13).
//
// Путь ответа три части, и тест закрывает каждую:
//  1) доставка — `loadAssets()` обязан возвращать собранные `md.js`/`smd.js`
//     (заглушка `// missing` молча роняет весь ESM-граф ленты);
//  2) стрим — чанки SSE `text` через `onText` → в ленте структура `.md`
//     (заголовок/список), а не сырой текст;
//  3) финализация хода — `onTurnEnd` не подменяет отрендеренный блок сырой
//     строкой (путь copy-actions должен читать тот же DOM).
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";
import { loadAssets } from "../src/modules/webui/assets";

const win = setupHappyDom(`<div id="msgs" class="msgs"></div>`);
(globalThis as unknown as Record<string, unknown>).DOMParser =
  (win as unknown as Record<string, unknown>).DOMParser;

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: {
    "web.code.copy": "copy",
    "web.code.copied": "copied",
    "web.code.copy_failed": "copy failed",
    "web.msg.copy": "Copy text",
    "web.msg.copy_md": "Copy markdown",
    "web.turn.end": "done · {count} tools",
  },
};

const store = await import("../src/modules/webui/assets/js/store.js");
const stream = await import("../src/modules/webui/assets/js/feed/stream.js");
const turn = await import("../src/modules/webui/assets/js/feed/turn.js");
const md = await import("../src/modules/webui/assets/md.js");

function mountTab(id: string): HTMLElement {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.body.appendChild(feed);
  store.tabs.tabs.push({ id, kind: "session", feed: feed as unknown as HTMLElement } as never);
  store.tabs.activeTabId = id;
  return feed as unknown as HTMLElement;
}

beforeEach(() => {
  store.tabs.tabs = [];
  store.tabs.activeTabId = null;
});

describe("markdown delivery (asset wiring)", () => {
  it("loadAssets serves real md.js/smd.js, not the `// missing` stub", () => {
    const assets = loadAssets();
    const mdJs = assets.mdJs ?? "";
    const smdJs = assets.smdJs ?? "";
    expect(mdJs).not.toBe("// missing");
    expect(mdJs.length).toBeGreaterThan(100);
    expect(smdJs).not.toBe("// missing");
    // Импортная граница md.js → smd.js: модуль отдаётся по этому ключу карты.
    const smdServed = assets.jsModules?.["smd.js"] ?? smdJs;
    expect(smdServed.length).toBeGreaterThan(100);
  });
});

describe("markdown streaming into the feed", () => {
  it("chunked SSE text renders .md structure with no raw markers", () => {
    const feed = mountTab("S1");
    // Мелкие чанки — как реальный SSE: маркеры режутся между чанками.
    for (const chunk of ["##Отчёт\n", "\n1) один\n", "2) два\n\n", "**bold**\n"]) {
      stream.onText(chunk, "S1");
    }
    stream.finishMd(feed);

    const node = feed.querySelector(".md");
    expect(node).not.toBeNull();
    expect(node?.querySelector("h2")?.textContent).toBe("Отчёт");
    expect(node?.querySelectorAll("ol > li")).toHaveLength(2);
    expect(node?.querySelector("strong")).not.toBeNull();
    expect(node?.textContent).not.toContain("##");
    expect(node?.textContent).not.toContain("**");
  });

  it("turn_end keeps the rendered markdown block (no raw re-render)", () => {
    const feed = mountTab("S2");
    stream.onText("##Title\n\ntext\n", "S2");
    turn.onTurnEnd({ sessionId: "S2", success: true, toolCalls: 0 });

    expect(feed.querySelectorAll(".md h2")).toHaveLength(1);
    // Сырого дубля заголовка в ленте быть не должно.
    expect((feed.textContent ?? "").split("Title").length).toBe(2);
    expect(feed.querySelector(".msg-actions")).not.toBeNull();
  });

  it("history path renders assistant text via renderMarkdown too", () => {
    const feed = mountTab("S3");
    // Тот же примитив, что зовёт `history.ts:renderAssistantText`.
    md.renderMarkdown(feed, "##H\n\n- a\n- b\n");
    expect(feed.querySelector(".md h2")?.textContent).toBe("H");
    expect(feed.querySelectorAll(".md li")).toHaveLength(2);
  });
});
