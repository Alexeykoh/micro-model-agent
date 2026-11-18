// DOM coverage for the file preview opened from chat (`js/file-view.ts`).
// The old preview hid the whole chat behind a tiny ✕; now it is a modal on the
// shared `#subOverlay` with a prominent close button, Escape/backdrop close,
// and a fetch guard so a late response cannot paint into a closed dialog.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { setupHappyDom } from "./helpers/happy-dom";

const HTML = `
  <div id="msgs" class="msgs" role="log"></div>
  <div class="overlay overlay-nested" id="subOverlay">
    <div class="modal modal-sub" role="dialog" aria-modal="true" aria-labelledby="subTitle">
      <div class="modal-top"><span id="subTitle"></span><button class="x linkbtn" id="closeSub" type="button">✕ close</button></div>
      <div class="modal-body provider-body" id="subHost"></div>
    </div>
  </div>`;

const win = setupHappyDom(HTML);
const g = globalThis as unknown as Record<string, unknown>;

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: {
    "web.dialog.close": "close",
    "web.files.loading": "Loading…",
    "web.files.open_failed": "Could not open this file.",
  },
};

const { openFilePreview, closeFilePreview } = await import(
  "../src/modules/webui/assets/js/file-view.js"
);

/** Per-path held responses: release deliberately to simulate a late answer. */
const held = new Map<
  string,
  Array<{ promise: Promise<Response>; resolve: (r: Response) => void }>
>();
const originalFetch = g.fetch;

function textResponse(text: string): Response {
  return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

beforeAll(() => {
  g.fetch = async (input: string | URL | Request): Promise<Response> => {
    const path = new URL(String(input), "http://localhost/").searchParams.get("path") ?? "";
    const queue = held.get(path);
    if (queue?.length) return queue.shift()?.promise ?? textResponse("");
    return textResponse("const a = 1;\nconst b = 2;");
  };
});

afterAll(() => {
  g.fetch = originalFetch;
});

/** Hold every response for `path` until `release()` is called. */
function hold(path: string): () => void {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  held.set(path, [{ promise, resolve }]);
  return () => {
    held.delete(path);
    resolve(textResponse("const a = 1;\nconst b = 2;"));
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const overlay = (): HTMLElement => win.document.getElementById("subOverlay") as HTMLElement;
const host = (): HTMLElement => win.document.getElementById("subHost") as HTMLElement;
const title = (): HTMLElement => win.document.getElementById("subTitle") as HTMLElement;
const close = (): HTMLElement => win.document.getElementById("closeSub") as HTMLElement;
const msgs = (): HTMLElement => win.document.getElementById("msgs") as HTMLElement;

describe("webui file preview modal", () => {
  it("opens on the shared subdialog without hiding the chat", async () => {
    openFilePreview("core/src/world/generator.ts");
    expect(overlay().classList.contains("open")).toBe(true);
    expect(title().textContent).toBe("core/src/world/generator.ts");
    expect(title().title).toBe("core/src/world/generator.ts");
    expect(close().textContent).toContain("close");
    expect(host().querySelector(".file-view .file-body")).not.toBeNull();
    expect(msgs().hidden).toBe(false);
    await flush();
  });

  it("paints the fetched file with the standard line gutter", async () => {
    openFilePreview("src/app.ts");
    await flush();
    expect(host().querySelector(".fpre .fcode")?.textContent).toContain("const a = 1;");
    expect(host().querySelector(".fv-gutter")?.textContent).toContain("1");
  });

  it("closes via the prominent close button and leaves the chat alone", () => {
    openFilePreview("src/a.ts");
    close().click();
    expect(overlay().classList.contains("open")).toBe(false);
    expect(msgs().hidden).toBe(false);
  });

  it("closes on Escape", () => {
    openFilePreview("src/b.ts");
    win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(overlay().classList.contains("open")).toBe(false);
    expect(msgs().hidden).toBe(false);
  });

  it("closes on backdrop click", () => {
    openFilePreview("src/c.ts");
    overlay().click();
    expect(overlay().classList.contains("open")).toBe(false);
  });

  it("ignores a late response after close", async () => {
    const release = hold("late.ts");
    openFilePreview("late.ts");
    closeFilePreview();
    release();
    await flush();
    expect(host().querySelector(".fpre")).toBeNull();
  });

  it("replaces the previous file and ignores its stale response", async () => {
    const release = hold("old.ts");
    openFilePreview("old.ts");
    openFilePreview("new.ts");
    await flush();
    release();
    await flush();
    expect(host().querySelectorAll(".file-view")).toHaveLength(1);
    expect(host().querySelector(".fpre .fcode")?.textContent).toContain("const a = 1;");
    closeFilePreview();
  });

  it("keeps the close button noticeable and the dialog near-fullscreen", () => {
    const css = readFileSync("src/modules/webui/assets/styles.css", "utf8");
    expect(css).toMatch(/#subOverlay:has\(\.file-view\) \.modal-sub\s*\{[^}]*width:\s*min\(1400px,\s*96vw\)/);
    expect(css).toMatch(/#subOverlay:has\(\.file-view\) #closeSub\s*\{[^}]*border:\s*1px solid var\(--red-strong\)/);
  });
});
