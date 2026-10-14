// DOM guard for the web update card: it renders, is dismissible, and does not
// resurrect on a later render of the same version — but re-arms for a new one.
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom();

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: {
    "web.update.card_title": "Update available — {latest}",
    "web.update.card_sub": "You're on {current}.",
    "web.update.install": "Install",
    "web.update.dismiss": "Dismiss",
  },
};

const updateState = await import("../src/modules/webui/assets/js/update-state.js");
const { updateCard } = await import("../src/modules/webui/assets/js/feed/update-card.js");

const container = win.document.createElement("div");
win.document.body.appendChild(container);

describe("update card", () => {
  let n = 0;
  beforeEach(() => {
    container.replaceChildren();
    // A fresh `latest` re-arms the card, isolating dismissal between tests.
    updateState.setUpdateInfo({ current: "0.3.2", latest: `0.4.${++n}` });
  });

  it("renders and is removed on dismiss", () => {
    const info = updateState.getUpdateInfo();
    const card = updateCard(info!);
    container.appendChild(card);
    expect(container.querySelector(".upd-card")).toBeTruthy();
    (card.querySelector(".upd-x") as HTMLElement).click();
    expect(container.querySelector(".upd-card")).toBeNull();
    // The update fact itself stays (footer chip / settings row still show it).
    expect(updateState.getUpdateInfo()).not.toBeNull();
    expect(updateState.isUpdateDismissed()).toBe(true);
  });

  it("stays dismissed for the same version and re-arms for a new one", () => {
    updateState.dismissUpdate();
    updateState.setUpdateInfo({ current: "0.3.2", latest: `0.4.${n}` });
    expect(updateState.isUpdateDismissed()).toBe(true);
    updateState.setUpdateInfo({ current: "0.3.2", latest: "0.9.0" });
    expect(updateState.isUpdateDismissed()).toBe(false);
  });
});
