// Real DOM coverage for the DLP details popup: secrets must expand into public
// kinds and masked fingerprints, never the original value (INV-DLP-6).
// `bun test` doesn't apply vitest's environment docblock, so happy-dom is wired
// manually (mirrors webui-controls-dom.test.ts).
import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.location = win.location;
g.localStorage = win.localStorage;

globalThis.document.body.innerHTML = `
  <div id="subOverlay">
    <div id="subTitle"></div>
    <div id="subHost"></div>
    <button id="closeSub" type="button"></button>
  </div>`;

const { egressBadge } = await import("../src/modules/webui/assets/js/feed/egress.js");
const { I18N } = await import("../src/modules/webui/assets/js/i18n.js");

I18N.locale = "en";
I18N.dicts = {
  en: {
    "web.dlp.title": "Data policy (DLP)",
    "web.dlp.badge": "DLP",
    "web.dlp.badgeTitle": "DLP: redacted values — {count}",
    "web.dlp.total": "Redacted values: {count}",
    "web.dlp.kinds": "({list})",
    "web.dlp.class.secret": "Secrets",
    "web.dlp.class.path": "Hidden paths",
    "web.dlp.kind.windows-abs": "absolute Windows path",
    "web.dlp.kind.file-content": "file matched a block rule",
    "web.dlp.secretKind.key": "API key",
    "web.dlp.secretKind.bearer": "Bearer token",
  },
};

describe("DLP details popup", () => {
  it("бейдж — маленькая жёлтая иконка щита с надписью DLP", () => {
    const badge = egressBadge({ total: 2, stats: { secret: 2 }, kinds: {}, targets: [] });
    expect(badge?.classList.contains("dlp-badge")).toBe(true);
    expect(badge?.querySelector(".dlp-shield")).not.toBeNull();
    expect(badge?.querySelector(".dlp-label")?.textContent).toBe("DLP");
    // Счётчик не занимает место в строке — он только в title.
    expect(badge?.textContent).toBe("DLP");
    expect(badge?.getAttribute("title")).toContain("2");
  });

  it("раскрывает секреты по типу и маскированному отпечатку", () => {
    const badge = egressBadge({
      total: 2,
      stats: { secret: 2 },
      kinds: { secret: ["secret"] },
      secrets: [
        { kind: "key", count: 1, previews: ["sk-a…89"] },
        { kind: "bearer", count: 1, previews: ["eyJh…3c"] },
      ],
      targets: [],
    });
    expect(badge).not.toBeNull();

    badge!.click();

    const host = document.getElementById("subHost") as HTMLElement;
    const text = host.textContent ?? "";
    expect(text).toContain("API key");
    expect(text).toContain("sk-a…89");
    expect(text).toContain("Bearer token");
    expect(text).toContain("eyJh…3c");
    expect(text).not.toContain("sk-abcdefghij");
  });

  it("пути и файлы под block-правилом подписаны по-человечески", () => {
    const badge = egressBadge({
      total: 2,
      stats: { path: 1, "file-content": 1 },
      kinds: { path: ["windows-abs"], "file-content": ["file-content"] },
      targets: [],
    });
    badge!.click();

    const text = (document.getElementById("subHost") as HTMLElement).textContent ?? "";
    expect(text).toContain("Hidden paths");
    expect(text).toContain("absolute Windows path");
    expect(text).toContain("file matched a block rule");
  });

  it("без детализации (старая история) рисует только «Секреты»", () => {
    const badge = egressBadge({
      total: 1,
      stats: { secret: 1 },
      kinds: { secret: ["secret"] },
      targets: [],
    });
    badge!.click();

    const host = document.getElementById("subHost") as HTMLElement;
    expect(host.textContent).toContain("Secrets");
    expect(host.querySelectorAll(".dlp-secret")).toHaveLength(0);
  });
});
