// DLP-псевдонимы в вопросе должны получать такую же человеческую подпись, как
// в превью аргументов тула: токен `<PATH:…>` не должен уходить пользователю.
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div id="msgs" class="msgs"></div>`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: {
    "web.egress.hidden": "hidden by data policy",
    "web.egress.hidden_short": "‹{kind}›",
  },
};

const store = await import("../src/modules/webui/assets/js/store.js");
const { onQuestion } = await import("../src/modules/webui/assets/js/feed/question.js");

function mountTab(id: string): HTMLElement {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.body.appendChild(feed);
  store.tabs.tabs.push({ id, feed });
  return feed as HTMLElement;
}

describe("question block masks DLP tokens", () => {
  let feed: HTMLElement;

  beforeEach(() => {
    store.tabs.tabs = [];
    feed = mountTab("S1");
  });

  it("replaces path pseudonyms in the prompt and option labels", () => {
    onQuestion({
      id: "q1",
      sessionId: "S1",
      kind: "choice",
      text: "Create MVP in <PATH:abc12345>/core/?",
      options: ["Yes, <PATH:abc12345>/core/", "At the root <PATH:abc12345>"],
    });

    const text = feed.textContent || "";
    expect(text).not.toContain("<PATH:");
    expect(text).toContain("‹PATH›/core/");
    expect(text).toContain("Yes, ‹PATH›/core/");
    expect(text).toContain("At the root ‹PATH›");
  });
});
