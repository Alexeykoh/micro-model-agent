// DOM coverage for the Files tab leaf module: lazy tree, split viewer, attach
// path, viewer history and the expand/collapse controls. `bun test` doesn't
// apply vitest's environment docblock, so happy-dom is wired manually and the
// fetch/API layer is stubbed.
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
          </div>
          <div class="files-tree" id="filesTree" tabindex="0"></div>
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
      { name: "docs", type: "dir" },
      { name: "readme.md", type: "file", size: 10 },
    ],
    truncated: false,
  },
  src: {
    path: "src",
    entries: [
      { name: "deep", type: "dir" },
      { name: "index.ts", type: "file", size: 3 },
    ],
    truncated: false,
  },
  "src/deep": {
    path: "src/deep",
    entries: [{ name: "leaf.ts", type: "file", size: 4 }],
    truncated: false,
  },
  docs: {
    path: "docs",
    entries: [{ name: "guide.md", type: "file", size: 5 }],
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
  },
};

const fileTexts: Record<string, string> = { "readme.md": "# readme" };
let fileText = "export const x = 1";
g.fetch = async (url: string): Promise<Response> => {
  if (url.startsWith("/api/files")) {
    const p = new URLSearchParams(url.split("?")[1] || "").get("path") || "";
    const body = listings[p] ?? { path: p, entries: [], truncated: false };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.startsWith("/api/file")) {
    const p = decodeURIComponent(url.split("path=")[1] || "");
    return new Response(fileTexts[p] ?? fileText, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response("{}", { status: 404 });
};

const sidebar = await import("../src/modules/webui/assets/js/sidebar.js");
sidebar.initFiles({ insertPath: (p) => inserted.push(p) });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const doc = (id: string) => win.document.getElementById(id) as HTMLElement;
const btn = (id: string) => doc(id) as HTMLButtonElement;
const tree = () => doc("filesTree");
const rows = () => Array.from(tree().querySelectorAll<HTMLElement>(".frow"));
const names = () => rows().map((r) => r.querySelector(".fname")?.textContent);
const rowByName = (name: string) =>
  rows().find((r) => r.querySelector(".fname")?.textContent === name) as HTMLElement;
const crumbs = () => Array.from(doc("filesCrumbs").querySelectorAll(".fcrumb")).map((c) => c.textContent);
const key = (target: EventTarget, k: string, init: Record<string, unknown> = {}) =>
  target.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));

let wsCounter = 0;

describe("files tab DOM", () => {
  beforeEach(async () => {
    inserted.length = 0;
    sidebar.setSidebarTab("files");
    // A fresh workspace resets the cached tree/expanded state between tests.
    sidebar.sidebarFilesState({ workspace: "/ws" + ++wsCounter });
    await flush();
  });

  it("renders the root lazily when the tab is shown", async () => {
    expect(names()).toEqual(["src", "docs", "readme.md"]);
  });

  // The empty chevron column on file rows read as "this file is nested".
  it("reserves the chevron cell for directories only", () => {
    expect(rowByName("src").querySelector(".ftw")).toBeTruthy();
    expect(rowByName("readme.md").querySelector(".ftw")).toBeNull();
    // Indentation comes from `--indent`, so file rows at depth 0 stay flush.
    expect(rowByName("readme.md").style.getPropertyValue("--indent")).toBe("0");
    expect(rowByName("src").style.getPropertyValue("--indent")).toBe("0");
  });

  it("expands a directory and lists its children", async () => {
    rowByName("src").click();
    await flush();
    expect(names()).toEqual(["src", "deep", "index.ts", "docs", "readme.md"]);
  });

  it("opens a file in the read-only viewer", async () => {
    rowByName("src").click();
    await flush();
    rowByName("index.ts").click();
    await flush();
    expect(doc("filesDetail").hidden).toBe(false);
    expect(crumbs()).toEqual(["src", "index.ts"]);
    expect(doc("filesBody").textContent).toContain("export const x = 1");
  });

  it("reveals and opens a workspace file from a chat link", async () => {
    // Chat links call `openFilesTabFor` (via the app hook): the tree must
    // expand every ancestor and select the file even though nothing was open.
    await sidebar.openFilesTabFor("src/deep/leaf.ts");
    await flush();
    await flush();
    expect(doc("filesDetail").hidden).toBe(false);
    expect(crumbs()).toEqual(["src", "deep", "leaf.ts"]);
    expect(names()).toContain("leaf.ts");
    expect(rows().find((r) => r.dataset.path === "src/deep/leaf.ts")?.className).toContain("sel");
  });

  // The original complaint: opening a file hid the whole tree (`:has()` CSS
  // rule), so every file switch meant close → re-navigate → re-expand.
  it("keeps the tree visible next to an open file (split, not takeover)", async () => {
    rowByName("readme.md").click();
    await flush();
    expect(doc("filesDetail").hidden).toBe(false);
    expect(win.document.querySelector(".files-splitter")).toBeTruthy();
    expect(doc("filesSide").hidden).toBe(false);
    expect(names()).toEqual(["src", "docs", "readme.md"]);
  });

  it("switches files with one click while the viewer is open", async () => {
    rowByName("readme.md").click();
    await flush();
    rowByName("src").click();
    await flush();
    rowByName("index.ts").click();
    await flush();
    expect(crumbs()).toEqual(["src", "index.ts"]);
    // tree survived both switches
    expect(names()).toContain("readme.md");
  });

  it("attaches a file path via the row button without opening the file", async () => {
    rowByName("readme.md").querySelector<HTMLElement>(".fattach")!.click();
    await flush();
    expect(inserted).toContain("readme.md");
    expect(doc("filesDetail").hidden).toBe(true);
  });

  it("closes the viewer when the workspace changes", async () => {
    rowByName("readme.md").click();
    await flush();
    expect(doc("filesDetail").hidden).toBe(false);
    sidebar.sidebarFilesState({ workspace: "/elsewhere" });
    await flush();
    expect(doc("filesDetail").hidden).toBe(true);
  });

  it("closes the viewer on Escape", async () => {
    rowByName("readme.md").click();
    await flush();
    key(win.document, "Escape");
    expect(doc("filesDetail").hidden).toBe(true);
    expect(doc("filesCrumbs").textContent).toBe("");
  });

  describe("expand/collapse controls", () => {
    it("collapses everything back to the root", async () => {
      rowByName("src").click();
      await flush();
      expect(names()).toContain("index.ts");
      btn("filesCollapseAll").click();
      await flush();
      expect(names()).toEqual(["src", "docs", "readme.md"]);
      expect((btn("filesCollapseAll") as HTMLButtonElement).disabled).toBe(true);
    });

    it("expands the whole tree lazily, level by level", async () => {
      btn("filesExpandAll").click();
      await flush();
      await flush();
      expect(names()).toEqual([
        "src", "deep", "leaf.ts", "index.ts",
        "docs", "guide.md",
        "readme.md",
      ]);
    });

    it("disables collapse/expand/refresh without a workspace", async () => {
      sidebar.sidebarFilesState({});
      await flush();
      expect(tree().textContent).toContain("no workspace");
      expect(btn("filesExpandAll").disabled).toBe(true);
      expect(btn("filesRefresh").disabled).toBe(true);
    });
  });

  describe("viewer history", () => {
    const openReadme = async () => {
      rowByName("readme.md").click();
      await flush();
    };
    const openIndex = async () => {
      rowByName("src").click();
      await flush();
      rowByName("index.ts").click();
      await flush();
    };

    it("starts with both directions disabled", async () => {
      await openReadme();
      expect(btn("filesBack").disabled).toBe(true);
      expect(btn("filesFwd").disabled).toBe(true);
    });

    it("walks back and forward through visited files", async () => {
      await openReadme();
      await openIndex();
      expect(btn("filesBack").disabled).toBe(false);
      btn("filesBack").click();
      await flush();
      expect(crumbs()).toEqual(["readme.md"]);
      expect(btn("filesFwd").disabled).toBe(false);
      btn("filesFwd").click();
      await flush();
      expect(crumbs()).toEqual(["src", "index.ts"]);
      expect(btn("filesFwd").disabled).toBe(true);
    });

    it("supports Alt+ArrowLeft / Alt+ArrowRight", async () => {
      await openReadme();
      await openIndex();
      key(win.document, "ArrowLeft", { altKey: true });
      await flush();
      expect(crumbs()).toEqual(["readme.md"]);
      key(win.document, "ArrowRight", { altKey: true });
      await flush();
      expect(crumbs()).toEqual(["src", "index.ts"]);
    });

    it("reuses an earlier entry instead of stacking duplicates", async () => {
      await openReadme();
      await openIndex();
      btn("filesBack").click();
      await flush();
      await openReadme();
      btn("filesFwd").click();
      await flush();
      expect(crumbs()).toEqual(["src", "index.ts"]);
      expect(btn("filesFwd").disabled).toBe(true);
    });

    it("keeps history after closing the viewer", async () => {
      await openReadme();
      await openIndex();
      btn("filesClose").click();
      expect(doc("filesDetail").hidden).toBe(true);
      expect(btn("filesBack").disabled).toBe(false);
      btn("filesBack").click();
      await flush();
      expect(doc("filesDetail").hidden).toBe(false);
      expect(crumbs()).toEqual(["readme.md"]);
    });
  });

  describe("breadcrumbs", () => {
    it("reveals a directory in the tree when its crumb is clicked", async () => {
      rowByName("src").click();
      await flush();
      rowByName("index.ts").click();
      await flush();
      const dirs = Array.from(doc("filesCrumbs").querySelectorAll<HTMLButtonElement>("button.fcrumb"));
      expect(dirs.length).toBe(1);
      dirs[0].click();
      await flush();
      expect(rows().find((r) => r.dataset.path === "src")?.className).toContain("cursor");
    });
  });

  describe("keyboard navigation", () => {
    const cursorPath = () =>
      rows().find((r) => r.className.includes("cursor"))?.dataset.path;

    it("opens a file with ArrowDown + Enter", async () => {
      key(tree(), "ArrowDown");
      expect(cursorPath()).toBe("src");
      key(tree(), "ArrowDown");
      expect(cursorPath()).toBe("docs");
      key(tree(), "ArrowDown");
      expect(cursorPath()).toBe("readme.md");
      key(tree(), "Enter");
      await flush();
      expect(doc("filesDetail").hidden).toBe(false);
      expect(crumbs()).toEqual(["readme.md"]);
    });

    it("expands with ArrowRight and jumps to the parent with ArrowLeft", async () => {
      key(tree(), "ArrowDown");
      expect(cursorPath()).toBe("src");
      key(tree(), "ArrowRight");
      await flush();
      expect(names()).toContain("index.ts");
      key(tree(), "ArrowDown");
      key(tree(), "ArrowDown");
      expect(cursorPath()).toBe("src/index.ts");
      key(tree(), "ArrowLeft");
      expect(cursorPath()).toBe("src");
    });

    it("collapses an expanded directory with ArrowLeft", async () => {
      rowByName("src").click();
      await flush();
      expect(cursorPath()).toBe("src");
      key(tree(), "ArrowLeft");
      await flush();
      expect(names()).toEqual(["src", "docs", "readme.md"]);
    });
  });

  describe("split", () => {
    it("resizes the tree with the keyboard", () => {
      const splitter = btn("filesSplitter");
      // The width is a custom property on the pane (not an inline `width`), so
      // the ≤1024px drawer can stack the tree and ignore the dragged width.
      const pane = doc("pane-files");
      const w = () => pane.style.getPropertyValue("--files-tree-w");
      const start = w();
      splitter.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      expect(w()).not.toBe(start);
      splitter.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      expect(w()).toBe("240px");
    });

    it("hides the tree on demand (viewer-only mode) and back", async () => {
      rowByName("readme.md").click();
      await flush();
      btn("filesWide").click();
      expect(doc("filesSide").hidden).toBe(true);
      expect(doc("filesSplitter").hidden).toBe(true);
      expect(btn("filesWide").getAttribute("aria-label")).toBe("show tree");
      btn("filesWide").click();
      expect(doc("filesSide").hidden).toBe(false);
      expect(btn("filesWide").getAttribute("aria-label")).toBe("hide tree");
    });

    // Regression: with the tree hidden, closing the file left the pane blank —
    // neither tree nor viewer visible.
    it("brings the tree back when the file is closed in viewer-only mode", async () => {
      rowByName("readme.md").click();
      await flush();
      btn("filesWide").click();
      expect(doc("filesSide").hidden).toBe(true);
      btn("filesClose").click();
      expect(doc("filesDetail").hidden).toBe(true);
      expect(doc("filesSide").hidden).toBe(false);
      expect(doc("filesSplitter").hidden).toBe(false);
      expect(names()).toEqual(["src", "docs", "readme.md"]);
      expect(btn("filesWide").getAttribute("aria-label")).toBe("hide tree");
      expect(btn("filesWide").disabled).toBe(true);
    });

    it("brings the tree back on Escape in viewer-only mode", async () => {
      rowByName("readme.md").click();
      await flush();
      btn("filesWide").click();
      key(win.document, "Escape");
      expect(doc("filesSide").hidden).toBe(false);
    });

    it("brings the tree back when the workspace changes in viewer-only mode", async () => {
      rowByName("readme.md").click();
      await flush();
      btn("filesWide").click();
      sidebar.sidebarFilesState({ workspace: "/elsewhere" });
      await flush();
      expect(doc("filesSide").hidden).toBe(false);
    });

    it("cannot hide the tree while no file is open", () => {
      expect(btn("filesWide").disabled).toBe(true);
    });
  });

  it("localizes the new controls (no hardcoded english titles)", () => {
    expect(btn("filesCollapseAll").getAttribute("aria-label")).toBe("collapse all");
    expect(btn("filesExpandAll").getAttribute("aria-label")).toBe("expand all");
    expect(btn("filesBack").getAttribute("aria-label")).toBe("back");
    expect(btn("filesAttach").getAttribute("aria-label")).toBe("attach");
    expect(doc("filesSplitter").title).toBe("tree width");
  });
});