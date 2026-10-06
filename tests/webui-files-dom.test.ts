// DOM coverage for the Files tab leaf module: lazy tree, viewer, attach path.
// `bun test` doesn't apply vitest's environment docblock, so happy-dom is wired
// manually and the fetch/API layer is stubbed.
import { describe, it, expect, beforeEach } from "vitest";
import { Window } from "happy-dom";

const HTML = `
  <div class="sb">
    <div class="sb-tabs" role="tablist">
      <button class="sb-tab on" type="button" role="tab" data-tab="session"><span class="sb-ico"></span></button>
      <button class="sb-tab" type="button" role="tab" data-tab="files"><span class="sb-ico"></span></button>
    </div>
    <div class="sb-pane" id="pane-session" role="tabpanel"><div class="sec-body" id="plan"></div></div>
    <div class="sb-pane" id="pane-files" role="tabpanel" hidden>
      <div class="files-tree" id="filesTree"></div>
      <div class="files-detail" id="filesDetail" hidden>
        <span id="filesGlyph"></span><span id="filesTitle"></span>
        <button id="filesAttach" type="button"></button>
        <button id="filesClose" type="button"></button>
        <div id="filesBody"></div>
      </div>
    </div>
  </div>`;

const listings: Record<string, unknown> = {
  "": {
    path: "",
    entries: [
      { name: "src", type: "dir" },
      { name: "readme.md", type: "file", size: 10 },
    ],
    truncated: false,
  },
  src: {
    path: "src",
    entries: [{ name: "index.ts", type: "file", size: 3 }],
    truncated: false,
  },
};

const win = new Window({ url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.location = win.location;
g.localStorage = win.localStorage;
win.document.body.innerHTML = HTML;

const inserted: string[] = [];
const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.dicts = {
  en: {
    "web.sidebar.tab_files": "Files",
    "web.sidebar.tab_session": "Session",
    "web.files.loading": "loading…",
    "web.files.empty": "no files",
    "web.files.open_failed": "open failed",
    "web.files.attach": "attach",
    "web.files.no_workspace": "no workspace",
  },
};

let fileText = "export const x = 1";
g.fetch = async (url: string): Promise<Response> => {
  if (url.startsWith("/api/files")) {
    const p = new URLSearchParams(url.split("?")[1] || "").get("path") || "";
    const body = listings[p] ?? { path: p, entries: [], truncated: false };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.startsWith("/api/file")) {
    return new Response(fileText, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return new Response("{}", { status: 404 });
};

const sidebar = await import("../src/modules/webui/assets/js/sidebar.js");
sidebar.initFiles({ insertPath: (p) => inserted.push(p) });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const tree = () => win.document.getElementById("filesTree");
const rows = () => tree().querySelectorAll(".frow");
const rowByName = (name: string) =>
  Array.from(rows()).find((r) => r.querySelector(".fname")?.textContent === name) as HTMLElement;

let wsCounter = 0;

describe("files tab DOM", () => {
  beforeEach(async () => {
    inserted.length = 0;
    win.document.getElementById("filesDetail").hidden = true;
    sidebar.setSidebarTab("files");
    // A fresh workspace resets the cached tree/expanded state between tests.
    sidebar.sidebarFilesState({ workspace: "/ws" + ++wsCounter });
    await flush();
  });

  it("renders the root lazily when the tab is shown", async () => {
    expect(Array.from(rows()).map((r) => r.querySelector(".fname")?.textContent)).toEqual([
      "src",
      "readme.md",
    ]);
  });

  it("expands a directory and lists its children", async () => {
    rowByName("src").click();
    await flush();
    expect(rowByName("index.ts")).toBeTruthy();
  });

  it("opens a file in the read-only viewer", async () => {
    rowByName("src").click();
    await flush();
    rowByName("index.ts").click();
    await flush();
    const detail = win.document.getElementById("filesDetail");
    expect(detail.hidden).toBe(false);
    expect(win.document.getElementById("filesTitle").textContent).toBe("src/index.ts");
    expect(win.document.getElementById("filesBody").textContent).toContain("export const x = 1");
  });

  it("attaches a file path via the row button", async () => {
    const at = rowByName("readme.md").querySelector(".fattach") as HTMLElement;
    at.click();
    expect(inserted).toContain("readme.md");
  });

  it("closes the viewer when the workspace changes", async () => {
    rowByName("readme.md").click();
    await flush();
    expect(win.document.getElementById("filesDetail").hidden).toBe(false);
    sidebar.sidebarFilesState({ workspace: "/elsewhere" });
    await flush();
    expect(win.document.getElementById("filesDetail").hidden).toBe(true);
  });
});
