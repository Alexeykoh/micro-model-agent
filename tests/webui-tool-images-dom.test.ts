// DOM-покрытие картинок тулов в ленте `mma web`: миниатюра из `tool_end.images`,
// лайтбокс по клику, фолбэк при битом файле (ротация) и replay истории.
// `bun test` не применяет vitest-докблок окружения — happy-dom вручную,
// как в webui-files-dom.test.ts.
import { describe, it, expect, beforeAll } from "vitest";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.location = win.location;
g.localStorage = win.localStorage;
g.HTMLElement = win.HTMLElement;
g.Node = win.Node;
g.Event = win.Event;
g.KeyboardEvent = win.KeyboardEvent;
g.navigator = win.navigator;

win.document.body.innerHTML = `<div id="msgs" class="msgs"></div>`;
const newFeed = (): HTMLElement => {
  const f = win.document.createElement("div");
  f.className = "feed";
  win.document.body.appendChild(f);
  return f;
};

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: {
    "web.card.attached_image": "attached image",
    "web.card.browser_viewport": "browser · viewport",
    "web.card.image_removed": "image removed (rotation)",
    "web.lightbox.close": "Close",
    "web.lightbox.open_tab": "Open in a new tab",
    "web.lightbox.copy": "Copy link",
    "web.lightbox.copied": "Link copied",
    "web.tool.output": "output",
    "web.tool.collapse": "collapse",
    "web.action.thinking": "Thinking",
    "web.action.show": "Show",
    "web.code.copy": "copy",
    "web.code.copied": "copied",
    "web.code.copy_failed": "failed",
    "web.empty.title": "No messages yet",
    "web.empty.hint": "Ask something",
  },
};

const URL1 = "/api/sessions/ses1/images/1728300000000-ab12cd.png";
const toolFriendly = (name: string) => `tool.friendly.${name}`;
// Подписи тулов отдаёт `labelOf` через `tool.friendly.*`; любой ключ — ключ.
for (const k of ["browser", "attach_image"]) i18n.I18N.dicts.en[toolFriendly(k)] = k;

const store = await import("../src/modules/webui/assets/js/store.js");
const turn = await import("../src/modules/webui/assets/js/feed/turn.js");
const { imageCard } = await import("../src/modules/webui/assets/js/feed/image-card.js");
const { loadHistory } = await import("../src/modules/webui/assets/js/feed/history.js");

function mountTab(id: string): HTMLElement {
  const feed = newFeed();
  store.tabs.tabs.push({ id, feed });
  return feed as HTMLElement;
}

function fireTool(feed: HTMLElement, id: string, extra: Record<string, unknown>): void {
  void feed;
  turn.onToolStart({ toolCallId: id, name: "browser", args: { action: "screenshot" }, sessionId: "ses1" });
  turn.onToolEnd({ toolCallId: id, name: "browser", success: true, durationMs: 10, output: "snap", sessionId: "ses1", ...extra });
}

describe("tool image cards in the live feed", () => {
  beforeAll(() => {
    mountTab("ses1");
  });

  it("renders a lazy thumbnail from tool_end.images", () => {
    const feed = win.document.querySelector(".feed") as HTMLElement;
    fireTool(feed, "t1", { images: [URL1] });

    const img = feed.querySelector(".imgcard .imgthumb");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe(URL1);
    expect(img?.getAttribute("loading")).toBe("lazy");
    expect(feed.querySelector(".imgcard .cap")?.textContent).toContain("viewport");
    expect(feed.querySelector(".imgcard img")?.parentElement?.tagName).toBe("DIV");
  });

  it("renders no card when the tool produced no image (no lying placeholder)", () => {
    const feed = win.document.querySelector(".feed") as HTMLElement;
    const before = feed.querySelectorAll(".imgcard").length;
    fireTool(feed, "t2", {});
    expect(feed.querySelectorAll(".imgcard").length).toBe(before);
  });

  it("opens the lightbox on thumbnail click and closes via ✕", () => {
    const thumb = win.document.querySelector(".imgcard .imgthumb") as HTMLElement;
    thumb.dispatchEvent(new win.Event("click"));

    const lb = win.document.body.querySelector(".lightbox") as HTMLElement;
    expect(lb).toBeTruthy();
    expect(lb.hidden).toBe(false);
    expect(lb.querySelector(".lb-img")?.getAttribute("src")).toBe(URL1);
    expect(lb.querySelector(".lb-open")?.getAttribute("href")).toBe(URL1);

    (lb.querySelector(".lb-close") as HTMLElement).dispatchEvent(new win.Event("click"));
    expect(lb.hidden).toBe(true);
  });

  it("swaps a broken image for the rotation notice", () => {
    const card = imageCard("browser", "/gone.png")!;
    const feed = win.document.querySelector(".feed") as HTMLElement;
    feed.appendChild(card);

    const img = card.querySelector("img") as HTMLElement;
    img.dispatchEvent(new win.Event("error"));

    expect(card.classList.contains("imgcard-missing")).toBe(true);
    expect(card.textContent).toContain("image removed (rotation)");
  });

  it("labels attach_image cards as attachments and rejects empty urls", () => {
    const card = imageCard("attach_image", URL1)!;
    expect(card.querySelector(".cap")?.textContent).toContain("attached image");
    expect(imageCard("browser", "")).toBeNull();
  });
});

describe("history replay of tool images", () => {
  it("renders thumbnails from history tool_result.images", async () => {
    const feed = newFeed();
    const payload = {
      history: [
        { ts: "2026-10-07T10:00:00.000Z", kind: "tool_call", toolCallId: "c1", name: "browser", args: { action: "screenshot" } },
        { ts: "2026-10-07T10:00:01.000Z", kind: "tool_result", toolCallId: "c1", tool: "browser", success: true, duration: 10, images: [URL1] },
        { ts: "2026-10-07T10:00:02.000Z", kind: "tool_call", toolCallId: "c2", name: "browser", args: {} },
        { ts: "2026-10-07T10:00:03.000Z", kind: "tool_result", toolCallId: "c2", tool: "browser", success: true, duration: 5 },
      ],
    };
    g.fetch = async () =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

    const tab = { id: "ses-hist", feed };
    const res = await loadHistory(tab as never);

    // Успешный replay возвращает undefined (карточки уже в ленте).
    expect(res?.gone ?? false).toBe(false);
    const imgs = feed.querySelectorAll(".imgcard .imgthumb");
    expect(imgs.length).toBe(1);
    expect(imgs[0].getAttribute("src")).toBe(URL1);
    expect(feed.querySelectorAll(".act").length).toBe(2);
  });
});
