// DOM coverage for the queued-message edit popup (`session/queue-edit.ts`),
// UX spec docs/specs/2026-11-07-webui-queue-edit-ux-design.md §4. Every test
// here fails against the pre-spec popup: no maxlength/counter, no close guard,
// no `btn` classes, no `not_queued` handling, no dim placeholder rows.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setupHappyDom } from "./helpers/happy-dom";

const HTML = `
  <div id="msgs" class="msgs"></div>
  <span class="saved" id="saveIndicator"></span>
  <div id="queueStrip" hidden></div>
  <div class="overlay overlay-nested" id="subOverlay">
    <div class="modal modal-sub" role="dialog" aria-modal="true" aria-labelledby="subTitle">
      <div class="modal-top"><span id="subTitle"></span><button class="x linkbtn" id="closeSub" type="button">✕ close</button></div>
      <div class="modal-body provider-body" id="subHost"></div>
    </div>
  </div>
  <div class="overlay" id="confirmOverlay">
    <div class="modal modal-sm" role="alertdialog" aria-modal="true" aria-labelledby="confirmTitle">
      <div class="modal-top"><span id="confirmTitle">confirm</span></div>
      <div class="modal-body confirm-body">
        <p class="confirm-msg" id="confirmMsg"></p>
        <div class="confirm-actions">
          <button class="linkbtn confirm-cancel" id="confirmCancel" type="button">cancel</button>
          <button class="linkbtn danger confirm-accept" id="confirmAccept" type="button">delete</button>
        </div>
      </div>
    </div>
  </div>`;

const win = setupHappyDom(HTML);
const g = globalThis as unknown as Record<string, unknown>;

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: {
    "web.input.queued": "queued · position {n}",
    "web.queue.unknown": "(queued message)",
    "web.queue.no_text": "no local copy — text arrives with the server queue",
    "web.queue.edit_title": "Edit queued message",
    "web.queue.edit_save": "Save",
    "web.queue.edit_failed": "Could not save the queued message",
    "web.queue.edit_placeholder": "Message text",
    "web.queue.edit_keep": "attachments kept",
    "web.queue.edit_discard_title": "Discard changes?",
    "web.queue.edit_discard_body": "The queued message will be sent with its original text.",
    "web.queue.edit_discard_accept": "Discard",
    "web.queue.edit_count": "{n} / {max}",
    "web.dialog.close": "close",
    "web.action.cancel": "cancel",
  },
};

const store = await import("../src/modules/webui/assets/js/store.js");
const subdialog = await import("../src/modules/webui/assets/js/subdialog.js");
const queue = await import("../src/modules/webui/assets/js/session/queue.js");
const queueEdit = await import("../src/modules/webui/assets/js/session/queue-edit.js");

/** Ответ сервера для `POST /api/queue/edit` следующим (mock вместо сети). */
let nextEditResponse: { status: number; body: Record<string, unknown> } = {
  status: 200,
  body: { ok: true },
};
let editPosts: Array<Record<string, unknown>> = [];

g.fetch = async (url: string, init?: { method?: string; body?: string }): Promise<Response> => {
  if (String(url).endsWith("/api/queue/edit")) {
    editPosts.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify(nextEditResponse.body), {
      status: nextEditResponse.status,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("{}", { status: 404 });
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function mountTab(id: string): Record<string, unknown> {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.body.appendChild(feed);
  const tab = { id, kind: "session", feed: feed as unknown as HTMLElement };
  store.tabs.tabs.push(tab);
  return tab as unknown as Record<string, unknown>;
}

const overlayEl = (): HTMLElement => win.document.getElementById("subOverlay") as HTMLElement;
const confirmEl = (): HTMLElement => win.document.getElementById("confirmOverlay") as HTMLElement;
const stripEl = (): HTMLElement => win.document.getElementById("queueStrip") as HTMLElement;
const host = (): HTMLElement => win.document.getElementById("subHost") as HTMLElement;
const textarea = (): HTMLTextAreaElement =>
  host().querySelector("textarea.qe-text") as HTMLTextAreaElement;
const saveBtn = (): HTMLButtonElement =>
  host().querySelector("button.qe-save") as HTMLButtonElement;
const indicator = (): HTMLElement => win.document.getElementById("saveIndicator") as HTMLElement;

beforeEach(() => {
  store.tabs.tabs = [];
  store.tabs.activeTabId = null;
  store.session.queued = {};
  store.session.queuedIds = {};
  stripEl().replaceChildren();
  stripEl().hidden = true;
  overlayEl().classList.remove("open");
  confirmEl().classList.remove("open");
  host().textContent = "";
  indicator().textContent = "";
  indicator().classList.remove("show", "fail");
  nextEditResponse = { status: 200, body: { ok: true } };
  editPosts = [];
  // Guard is module-global (one open sub dialog at a time): disarm it between tests.
  subdialog.setSubDialogCloseGuard(null);
});

describe("queued-message edit popup (UX spec 2026-11-07)", () => {
  it("gives the textarea the composer limit and a counter node (Q2)", () => {
    const tab = mountTab("A");
    store.tabs.activeTabId = "A";
    queueEdit.openQueueEdit(tab as never, "q1", "original text", () => {}, []);

    const area = textarea();
    expect(area.maxLength).toBe(32768);
    const counter = host().querySelector(".qe-count");
    expect(counter).not.toBeNull();
    expect(counter?.textContent).toBe("13 / 32768");
  });

  it("renders actions as .btn / .btn.primary (Q1)", () => {
    const tab = mountTab("B");
    store.tabs.activeTabId = "B";
    queueEdit.openQueueEdit(tab as never, "q1", "text", () => {}, []);

    expect(saveBtn().classList.contains("btn")).toBe(true);
    expect(saveBtn().classList.contains("primary")).toBe(true);
    const cancel = host().querySelector("button.qe-cancel");
    expect(cancel?.classList.contains("btn")).toBe(true);
  });

  it("shows the attachments note when the message carries images (Q6)", () => {
    const tab = mountTab("C");
    store.tabs.activeTabId = "C";
    queueEdit.openQueueEdit(tab as never, "q1", "text", () => {}, ["data:image/png;base64,AA"]);

    const imgs = host().querySelector(".qe-imgs");
    expect(imgs).not.toBeNull();
    expect(imgs?.textContent).toBe("attachments kept");
  });

  it("closeSubDialog with unsaved edits refuses to close and opens the confirm (Q3)", () => {
    const tab = mountTab("D");
    store.tabs.activeTabId = "D";
    queueEdit.openQueueEdit(tab as never, "q1", "original", () => {}, []);

    const area = textarea();
    area.value = "edited";
    area.dispatchEvent(new win.Event("input", { bubbles: true }));

    subdialog.closeSubDialog();
    expect(overlayEl().classList.contains("open")).toBe(true);
    expect(confirmEl().classList.contains("open")).toBe(true);
    expect(win.document.getElementById("confirmTitle")?.textContent).toBe("Discard changes?");
  });

  it("closeSubDialog without edits closes instantly (Q3)", () => {
    const tab = mountTab("E");
    store.tabs.activeTabId = "E";
    queueEdit.openQueueEdit(tab as never, "q1", "original", () => {}, []);

    subdialog.closeSubDialog();
    expect(overlayEl().classList.contains("open")).toBe(false);
    expect(confirmEl().classList.contains("open")).toBe(false);
  });

  it("confirming the discard closes the popup without posting (Q3)", async () => {
    const tab = mountTab("F");
    store.tabs.activeTabId = "F";
    queueEdit.openQueueEdit(tab as never, "q1", "original", () => {}, []);

    const area = textarea();
    area.value = "edited";
    area.dispatchEvent(new win.Event("input", { bubbles: true }));
    subdialog.closeSubDialog();
    win.document.getElementById("confirmAccept")?.click();
    await flush();

    expect(overlayEl().classList.contains("open")).toBe(false);
    expect(editPosts.length).toBe(0);
  });

  it("a `404 not_queued` reply closes the popup with a fail toast (Q5)", async () => {
    const tab = mountTab("G");
    store.tabs.activeTabId = "G";
    queueEdit.openQueueEdit(tab as never, "q1", "original", () => {}, []);

    nextEditResponse = { status: 404, body: { error: "not_queued" } };
    saveBtn().click();
    await flush();

    expect(overlayEl().classList.contains("open")).toBe(false);
    expect(indicator().classList.contains("fail")).toBe(true);
    expect(indicator().textContent).toBe("Could not save the queued message");
  });

  it("a `400` reply keeps the popup open with a visible error (Q5)", async () => {
    const tab = mountTab("H");
    store.tabs.activeTabId = "H";
    queueEdit.openQueueEdit(tab as never, "q1", "original", () => {}, []);

    nextEditResponse = { status: 400, body: { error: "bad_request" } };
    saveBtn().click();
    await flush();

    expect(overlayEl().classList.contains("open")).toBe(true);
    const err = host().querySelector(".qe-err");
    expect(err).not.toBeNull();
    expect(err?.textContent).toBe("Could not save the queued message");
  });

  it("saves the new text and syncs the local row (existing contract)", async () => {
    const tab = mountTab("I");
    store.tabs.activeTabId = "I";
    store.session.queuedIds = { I: ["q1"] };
    queue.enqueuePending(tab as never, { id: "q1", text: "original", images: [] });
    let saved = "";
    queueEdit.openQueueEdit(
      tab as never,
      "q1",
      "original",
      (_s, _id, text) => {
        saved = text;
      },
      [],
    );

    const area = textarea();
    area.value = "fixed text";
    area.dispatchEvent(new win.Event("input", { bubbles: true }));
    saveBtn().click();
    await flush();

    expect(editPosts[0]).toMatchObject({ sessionId: "I", id: "q1", text: "fixed text" });
    expect(saved).toBe("fixed text");
    expect(overlayEl().classList.contains("open")).toBe(false);
  });

  it("a placeholder row without local text is dim, titled and not clickable (Q4)", () => {
    const tab = mountTab("J");
    store.tabs.activeTabId = "J";
    // The server reports `qX` (another tab / reload mid-turn), this client has no copy.
    store.session.queuedIds = { J: ["qX"] };
    queue.renderQueueStrip();

    const line = stripEl().querySelector(".queue-item") as HTMLElement;
    const textEl = line.querySelector(".qi-text") as HTMLElement;
    expect(textEl.classList.contains("qi-dim")).toBe(true);
    expect(textEl.title).toBe("no local copy — text arrives with the server queue");

    line.click();
    expect(overlayEl().classList.contains("open")).toBe(false);
  });

  it("a row with local text stays clickable and opens the editor", () => {
    const tab = mountTab("K");
    store.tabs.activeTabId = "K";
    store.session.queuedIds = { K: ["q1"] };
    queue.enqueuePending(tab as never, { id: "q1", text: "mine", images: [] });
    queue.renderQueueStrip();

    const line = stripEl().querySelector(".queue-item") as HTMLElement;
    const textEl = line.querySelector(".qi-text") as HTMLElement;
    expect(textEl.classList.contains("qi-dim")).toBe(false);

    line.click();
    expect(overlayEl().classList.contains("open")).toBe(true);
    expect(textarea().value).toBe("mine");
  });
});

// happy-dom never computes the cascade, so "the popup has no CSS" (defect 1)
// is only checkable by scanning the stylesheet itself.
describe("queued-message edit popup CSS (spec §4 guard)", () => {
  const css = readFileSync(join(process.cwd(), "src/modules/webui/assets/styles.css"), "utf8");

  it("styles the textarea as a field: min-height + vertical resize (Q1)", () => {
    const block = css.match(/\.queue-edit \.qe-text\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toContain("min-height");
    expect(block).toContain("resize: vertical");
  });

  it("gives `.qe-err` the error color (defect 3)", () => {
    const block = css.match(/\.queue-edit \.qe-err\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toContain("var(--red-strong)");
  });

  it("styles the action row with buttons (Q1)", () => {
    const block = css.match(/\.queue-edit \.qe-actions \.btn\.primary\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toContain("var(--accent)");
  });

  it("dims placeholder queue rows (Q4)", () => {
    const block = css.match(/\.queue-item \.qi-dim\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toContain("var(--dim-a)");
  });
});
