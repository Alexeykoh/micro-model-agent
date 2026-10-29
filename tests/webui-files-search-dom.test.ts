// DOM coverage for content search in the Files tab (C-01): debounced input,
// `path:line` results, click opens the viewer at the line, empty/error states
// and clearing the query brings the tree back.
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
      <div class="files-body">
        <div class="files-side" id="filesSide">
          <div class="files-bar" id="filesBar">
            <button class="fbtn" type="button" id="filesCollapseAll"></button>
            <button class="fbtn" type="button" id="filesExpandAll"></button>
            <button class="fbtn" type="button" id="filesRefresh"></button>
            <input class="fsearch" id="filesSearch" type="search" />
          </div>
          <div class="files-tree" id="filesTree" tabindex="0"></div>
          <div class="files-search-results" id="filesSearchResults" hidden></div>
        </div>
        <div class="files-splitter" id="filesSplitter" role="separator" tabindex="0"></div>
        <div class="files-detail" id="filesDetail" hidden>
          <div class="detail-h">
            <button class="fbtn" type="button" id="filesBack" disabled></button>
            <button class="fbtn" type="button" id="filesFwd" disabled></button>
            <span class="fcrumbs" id="filesCrumbs"></span>
            <button class="fbtn" type="button" id="filesAttach"></button>
            <button class="fbtn" type="button" id="filesWide"></button>
            <button class="fbtn" type="button" id="filesClose"></button>
          </div>
          <div class="detail-b" id="filesBody"></div>
        </div>
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
    entries: [{ name: "app.ts", type: "file", size: 3 }],
    truncated: false,
  },
};

const win = new Window({ url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.location = win.location;
g.localStorage = win.localStorage;
g.getComputedStyle = win.getComputedStyle.bind(win);
win.document.body.innerHTML = HTML;

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.dicts = {
  en: {
    "web.sidebar.tab_files": "Files",
    "web.sidebar.tab_session": "Session",
    "web.files.loading": "loading…",
    "web.files.empty": "no files",
    "web.files.error": "tree failed",
    "web.files.truncated": "truncated",
    "web.files.open_failed": "open failed",
    "web.files.attach": "attach",
    "web.files.close": "close",
    "web.files.back": "back",
    "web.files.forward": "forward",
    "web.files.wide": "hide tree",
    "web.files.narrow": "show tree",
    "web.files.collapse_all": "collapse all",
    "web.files.expand_all": "expand all",
    "web.files.refresh": "refresh",
    "web.files.tree_width": "tree width",
    "web.files.no_workspace": "no workspace",
    "web.files.expand_capped": "expanded up to the limit of {n} folders.",
    "web.files.search_placeholder": "search files or contents",
    "web.files.search_no_results": "no matches",
    "web.files.search_error": "search failed",
    "web.files.search_truncated": "showing the first {n} matches",
  },
};

const fileTexts: Record<string, string> = {
  "src/app.ts": "line one\nconst needle = 1\nline three",
};
let searchFails = false;

g.fetch = async (url: string): Promise<Response> => {
  if (url.startsWith("/api/search")) {
    if (searchFails) return new Response("{}", { status: 500 });
    const q = new URLSearchParams(url.split("?")[1] || "").get("q") || "";
    const results =
      q === "app.ts"
        ? [{ kind: "path", path: "src/app.ts" }]
        : q === "needle" || q === "many"
          ? [{ kind: "content", path: "src/app.ts", line: 2, text: "const needle = 1" }]
          : [];
    return new Response(
      JSON.stringify({ results, truncated: q === "many", ms: 1 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (url.startsWith("/api/files")) {
    const p = new URLSearchParams(url.split("?")[1] || "").get("path") || "";
    const body = listings[p] ?? { path: p, entries: [], truncated: false };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.startsWith("/api/file")) {
    const p = decodeURIComponent(url.split("path=")[1] || "");
    return new Response(fileTexts[p] ?? "", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response("{}", { status: 404 });
};

const sidebar = await import("../src/modules/webui/assets/js/sidebar.js");
sidebar.initFiles({ insertPath: () => {} });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const doc = (id: string) => win.document.getElementById(id) as HTMLElement;
const input = () => doc("filesSearch") as HTMLInputElement;
const results = () => doc("filesSearchResults");
const resultRows = () =>
  Array.from(results().querySelectorAll<HTMLElement>(".fsearch-row"));

/** Types into the field and submits with Enter (bypasses the 300 ms debounce). */
const search = async (value: string): Promise<void> => {
  input().value = value;
  input().dispatchEvent(new win.Event("input", { bubbles: true }));
  input().dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();
};

let wsCounter = 0;

describe("files content search DOM", () => {
  beforeEach(async () => {
    searchFails = false;
    sidebar.setSidebarTab("files");
    sidebar.sidebarFilesState({ workspace: `/ws${++wsCounter}` });
    await flush();
  });

  it("renders `path:line` and the matched line, hiding the tree", async () => {
    await search("needle");
    expect(results().hidden).toBe(false);
    expect(doc("filesTree").hidden).toBe(true);
    expect(resultRows().length).toBe(1);
    expect(resultRows()[0].textContent).toContain("src/app.ts:2");
    expect(resultRows()[0].textContent).toContain("const needle = 1");
  });

  it("renders a name hit without a line and opens the file from the top", async () => {
    await search("app.ts");
    expect(resultRows().length).toBe(1);
    expect(resultRows()[0].className).toContain("fsearch-file");
    expect(resultRows()[0].textContent).toBe("src/app.ts");
    expect(resultRows()[0].textContent).not.toContain(":2");
    resultRows()[0].click();
    await flush();
    expect(doc("filesDetail").hidden).toBe(false);
    expect(doc("filesBody").textContent).toContain("line one");
    expect(doc("filesCrumbs").textContent).toContain("app.ts");
  });

  it("opens the file at the matched line in the existing viewer", async () => {    await search("needle");
    resultRows()[0].click();
    await flush();
    expect(doc("filesDetail").hidden).toBe(false);
    // crumbs are buttons; textContent of the path chain
    expect(doc("filesCrumbs").textContent).toContain("src");
    expect(doc("filesCrumbs").textContent).toContain("app.ts");
    expect(doc("filesBody").textContent).toContain("const needle = 1");
  });

  it("resets the results scroll position for a new query", async () => {
    await search("needle");
    results().scrollTop = 120;
    await search("many");
    // Without the reset, the new hit list can open mid-scroll and look empty.
    expect(results().scrollTop).toBe(0);
  });

  it("shows a localized empty state", async () => {
    await search("nothing-matches");
    expect(resultRows().length).toBe(0);
    expect(results().textContent).toContain("no matches");
  });

  it("shows a localized error state", async () => {
    searchFails = true;
    await search("needle");
    expect(results().textContent).toContain("search failed");
  });

  it("clears the query with Escape and brings the tree back", async () => {
    await search("needle");
    expect(doc("filesTree").hidden).toBe(true);
    input().dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(input().value).toBe("");
    expect(doc("filesTree").hidden).toBe(false);
    expect(results().hidden).toBe(true);
  });

  it("localizes the placeholder", () => {
    expect(input().placeholder).toBe("search files or contents");
    expect(input().getAttribute("aria-label")).toBe("search files or contents");
  });

  it("alerts truncated result sets", async () => {
    // Server reports `truncated`; the panel must not silently claim completeness.
    await search("many");
    expect(results().textContent).toContain("showing the first 1 matches");
  });
});
