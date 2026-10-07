// DOM coverage for the Plugins tab leaf module: lazy load, rows, toggles,
// details popup. `bun test` doesn't apply vitest's environment docblock, so
// happy-dom is wired manually and the fetch/API layer is stubbed.
import { describe, it, expect, beforeEach } from "vitest";
import { Window } from "happy-dom";

const HTML = `
  <div class="sb">
    <div class="sb-tabs" role="tablist">
      <button class="sb-tab on" type="button" role="tab" data-tab="session"><span class="sb-ico"></span></button>
      <button class="sb-tab" type="button" role="tab" data-tab="plugins"><span class="sb-ico"></span></button>
    </div>
    <div id="sbName"><span class="sb-ico"></span><span id="sbNameText">Session</span></div>
    <div class="sb-pane" id="pane-session" role="tabpanel"><div class="sec-body" id="plan"></div></div>
    <div class="sb-pane" id="pane-plugins" role="tabpanel" data-pane="plugins" hidden>
      <div class="sec map-sec"><div class="sec-body" id="pluginsBody"></div></div>
    </div>
  </div>
  <div class="overlay overlay-nested" id="subOverlay">
    <div class="modal"><div class="modal-top"><span id="subTitle"></span></div>
      <div class="modal-body" id="subHost"></div></div>
  </div>`;

const win = new Window({ url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.location = win.location;
g.localStorage = win.localStorage;
win.document.body.innerHTML = HTML;

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.dicts = {
  en: {
    "web.sidebar.tab_session": "Session",
    "web.sidebar.tab_plugins": "Plugins",
    "web.plugins.loading": "loading…",
    "web.plugins.empty": "no plugins",
    "web.plugins.unavailable": "unavailable",
    "web.plugins.summary": "{active} active · {off} off",
    "web.plugins.failed_count": "{count} failed",
    "web.plugins.enable": "enable",
    "web.plugins.disable": "disable",
    "web.plugins.toggle_failed": "toggle failed",
    "web.plugins.switch_enabled": "enabled",
    "web.plugins.state": "state",
    "web.plugins.version": "version",
    "web.plugins.tools": "tools",
    "web.plugins.hooks": "hooks",
    "web.plugins.no_description": "no description",
    "web.plugins.permissions_none": "none declared",
    "web.plugins.permissions_hint": "declaration, not enforcement",
    "web.plugins.warnings": "warnings",
    "web.plugins.copy_path": "copy",
    "web.plugins.copied": "copied",
    "web.plugins.badge_builtin": "builtin",
    "web.plugins.badge_draft": "draft",
    "cli.plugins.on": "on",
    "cli.plugins.off": "off",
    "cli.plugins.author": "author",
    "cli.plugins.homepage": "homepage",
    "cli.plugins.perms_label": "permissions",
    "cli.plugins.not_found": "not found: {name}",
  },
};

function record(patch: Record<string, unknown>): Record<string, unknown> {
  return {
    source: "project",
    builtin: false,
    draft: false,
    enabled: true,
    provides: { tools: [], hooks: [] },
    permissions: [],
    warnings: [],
    ...patch,
  };
}

let server: {
  plugins: Array<Record<string, unknown>>;
  failures: Array<Record<string, unknown>>;
};
let posts: Array<{ path: string; body: unknown }> = [];
let listCalls = 0;

const enabled = (name: string) => server.plugins.find((p) => p.name === name)?.enabled === true;

g.fetch = async (url: string, init?: RequestInit): Promise<Response> => {
  if (init?.method === "POST" && url.startsWith("/api/plugins/")) {
    const name = decodeURIComponent(url.slice("/api/plugins/".length));
    const body = JSON.parse(String(init.body || "{}")) as { enabled: boolean };
    posts.push({ path: url, body });
    const target = server.plugins.find((p) => p.name === name);
    if (!target) return new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404 });
    target.enabled = body.enabled;
    return new Response(
      JSON.stringify({ ok: true, persisted: true, plugins: server.plugins, failures: server.failures }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (url.startsWith("/api/plugins")) {
    listCalls++;
    return new Response(JSON.stringify(server), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("{}", { status: 404 });
};

const sidebar = await import("../src/modules/webui/assets/js/sidebar.js");
const sbState = await import("../src/modules/webui/assets/js/sidebar/state.js");
// Как `webui-files-dom.test.ts`: НЕ зовём `initSidebar()` — он кэширует `sb.el`
// в process-global happy-dom и ломает соседние DOM-тесты. Вкладке достаточно
// собственного узла + ленивого хука из `setSidebarTab`.
sbState.sb.plugins.bodyEl = win.document.getElementById("pluginsBody");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const body = () => win.document.getElementById("pluginsBody") as HTMLElement;
const rows = () => Array.from(body().querySelectorAll(".plg-row"));
const rowByName = (name: string) =>
  rows().find((r) => r.querySelector(".plg-name")?.textContent === name) as HTMLElement;

/**
 * Узел поп-апа. `subdialog.ts` разрешает `#subOverlay` лениво (по `document` на
 * момент вызова), но bun-процесс общий для всех DOM-тестов: активным может
 * оказаться чужое окно. Поэтому ищем документ, где реально лежит наш `.plg-info`.
 */
function popupHost(): HTMLElement {
  const docs: Document[] = [win.document, globalThis.document as Document];
  for (const doc of docs) {
    const node = doc?.getElementById("subHost") as HTMLElement | null;
    if (node && node.querySelector(".plg-info")) return node;
  }
  throw new Error("plugins popup host not found");
}

/** Заголовок берём из того же документа, где найден поп-ап. */
function popupTitle(): string {
  const host = popupHost();
  const doc = host.ownerDocument;
  return (doc.getElementById("subTitle") as HTMLElement)?.textContent || "";
}

/** Сбросить кэш вкладки и переактивировать её — принудительный свежий GET. */
async function freshTab(): Promise<void> {
  sbState.sb.plugins.loaded = false;
  sbState.sb.plugins.unavailable = false;
  sidebar.setSidebarTab("session");
  sidebar.setSidebarTab("plugins");
  await flush();
}

describe("plugins tab DOM", () => {
  beforeEach(async () => {
    posts = [];
    listCalls = 0;
    server = {
      plugins: [
        record({ name: "my-plugin", version: "1.2.3", author: "alexe", description: "does a thing" }),
        record({ name: "off-plugin", enabled: false }),
        record({ name: "builtin-a", builtin: true, source: "builtin", warnings: ["author is empty"] }),
        record({ name: "draft-p", draft: true }),
      ],
      failures: [{ entry: "broken/plugin.ts", path: "/p/broken/plugin.ts", message: "Unexpected token" }],
    };
    // Сброс кэша вкладки: снимаем флаг «загружено», чтобы был свежий GET.
    await freshTab();
  });

  it("loads the registry lazily, only when the tab is active", async () => {
    expect(listCalls).toBeGreaterThanOrEqual(1);
    expect(rows().length).toBe(5); // 4 плагина + 1 строка отказа
  });

  it("does not fetch while another tab is active", async () => {
    listCalls = 0;
    sidebar.setSidebarTab("session");
    sidebar.sidebarPluginsState();
    await flush();
    expect(listCalls).toBe(0);
  });

  it("shows name, version and author per row", () => {
    const row = rowByName("my-plugin");
    expect(row.textContent).toContain("my-plugin");
    expect(row.textContent).toContain("v1.2.3");
    expect(row.textContent).toContain("alexe");
  });

  it("renders the description as a dim line under the row", () => {
    expect(body().textContent).toContain("does a thing");
  });

  it("marks a disabled plugin with the dim glyph and an off toggle", () => {
    const row = rowByName("off-plugin");
    expect(row.querySelector(".plg-g")?.textContent).toBe("–");
    expect(row.querySelector(".toggle.on")).toBeNull();
  });

  it("marks a plugin with metadata warnings", () => {
    expect(rowByName("builtin-a").querySelector(".plg-g")?.textContent).toBe("⚠");
  });

  it("labels a draft plugin", () => {
    expect(rowByName("draft-p").textContent).toContain("draft");
  });

  it("sorts external plugins before builtins", () => {
    const names = rows().map((r) => r.querySelector(".plg-name")?.textContent);
    expect(names.indexOf("builtin-a")).toBe(names.length - 2); // перед отказом
    expect(names.indexOf("my-plugin")).toBeLessThan(names.indexOf("builtin-a"));
  });

  it("summarizes active/off/failed counts", () => {
    const summary = body().querySelector(".plg-summary")?.textContent || "";
    expect(summary).toContain("3 active · 1 off");
    expect(summary).toContain("1 failed");
  });

  it("surfaces a failed plugin instead of hiding it", () => {
    const broken = rows().find((r) => r.classList.contains("plg-broken"));
    expect(broken?.textContent).toContain("broken/plugin.ts");
    expect(broken?.textContent).toContain("Unexpected token");
  });

  it("toggles a plugin live via POST and redraws from the server answer", async () => {
    const toggle = rowByName("off-plugin").querySelector(".toggle") as HTMLElement;
    expect(toggle.getAttribute("role")).toBe("switch");
    toggle.click();
    await flush();
    expect(posts).toEqual([{ path: "/api/plugins/off-plugin", body: { enabled: true } }]);
    expect(enabled("off-plugin")).toBe(true);
    expect(rowByName("off-plugin").querySelector(".toggle.on")).toBeTruthy();
  });

  it("does not flip the toggle when the server rejects it", async () => {
    // Плагин исчезает из реестра между GET и POST → 404 → истина остаётся
    // прежней: строка на месте, тумблер не переключился.
    server.plugins = server.plugins.filter((p) => p.name !== "my-plugin");
    const toggle = rowByName("my-plugin").querySelector(".toggle") as HTMLElement;
    toggle.click();
    await flush();
    expect(posts[0].path).toBe("/api/plugins/my-plugin");
    expect(rowByName("my-plugin").querySelector(".toggle.on")).toBeTruthy();
  });

  it("opens a details popup with description, author, permissions and path", async () => {
    server.plugins[0] = record({
      name: "my-plugin",
      version: "1.2.3",
      author: "alexe",
      description: "does a thing",
      homepage: "https://example.com/p",
      path: "/p/.mma/plugins/my-plugin/plugin.ts",
      permissions: ["fs:read", "process"],
      provides: { tools: ["foo_run"], hooks: ["onToolEnd"] },
    });
    await freshTab();
    rowByName("my-plugin").click();
    expect(popupTitle()).toBe("my-plugin");
    const host = popupHost();
    const text = host.textContent || "";
    expect(text).toContain("does a thing");
    expect(text).toContain("alexe");
    expect(text).toContain("v1.2.3");
    expect(text).toContain("fs:read, process");
    expect(text).toContain("foo_run");
    expect(text).toContain("onToolEnd");
    expect(text).toContain("/p/.mma/plugins/my-plugin/plugin.ts");
    expect(text).toContain("declaration, not enforcement");
    const link = host.querySelector("a.plg-link") as HTMLAnchorElement;
    expect(link.href).toBe("https://example.com/p");
    expect(link.rel).toBe("noopener noreferrer");
  });

  it("shows the 'no description' hint for a bare plugin", async () => {
    server.plugins = [record({ name: "bare" })];
    await freshTab();
    rowByName("bare").click();
    expect(popupHost().textContent).toContain("no description");
  });

  it("toggles from the details popup too", async () => {
    rowByName("my-plugin").click();
    const toggle = popupHost().querySelector(".toggle") as HTMLElement;
    toggle.click();
    await flush();
    expect(posts[0]).toEqual({ path: "/api/plugins/my-plugin", body: { enabled: false } });
    expect(enabled("my-plugin")).toBe(false);
  });

  it("refetches when the registry changes elsewhere (SSE plugins)", async () => {
    listCalls = 0;
    sidebar.sidebarPluginsEvent();
    await flush();
    expect(listCalls).toBe(1);
  });
});
