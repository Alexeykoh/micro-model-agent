import { describe, it, expect } from "vitest";
import { loadAssets } from "../src/modules/webui/assets";

describe("webui assets", () => {
  it("loads html/css/js from disk", () => {
    const a = loadAssets();
    expect(a.html).toContain("<!DOCTYPE html>");
    expect(a.css.length).toBeGreaterThan(10);
    expect(a.js).toContain("EventSource");
  });

  // No DOM harness is available in the unit test env, so this is a source-level
  // guard: the feed renders the plan card from a dedicated SSE `plan` event.
  it("wires the plan event to the .planblock feed card", () => {
    const a = loadAssets();
    expect(a.js).toContain('addEventListener("plan"');
    expect(a.js).toContain("planblock");
    expect(a.css).toContain(".planblock");
  });

  it("wires the question event to an interactive .q block posting /api/answer", () => {
    const a = loadAssets();
    expect(a.js).toContain('addEventListener("question"');
    expect(a.js).toContain("/api/answer");
    expect(a.js).toContain("qopt");
    expect(a.css).toContain(".q .qopt");
  });

  it("wires the OutputBus log event and the immediate busy indicator", () => {
    const a = loadAssets();
    expect(a.js).toContain('addEventListener("log"');
    expect(a.js).toContain("showBusy(");
    expect(a.css).toContain(".busy .busytime");
  });

  it("wires the file card's Open link to /api/file in a new tab", () => {
    const a = loadAssets();
    expect(a.js).toMatch(/el\("a", "fc-open"[\s\S]{0,200}?target = "_blank"/);
    expect(a.js).toContain('openLink.rel = "noopener noreferrer"');
    expect(a.js).not.toContain("&token=");
    expect(a.css).toContain(".filecard .fc-open");
  });

  it("renders reasoning blocks collapsed by default", () => {
    const a = loadAssets();
    expect(a.js).toContain('"think-body hidden"');
  });

  it("listens for the dedicated reasoning event", () => {
    const a = loadAssets();
    expect(a.js).toContain('addEventListener("reasoning"');
    expect(a.js).toContain('addEventListener("meta"');
    expect(a.js).not.toContain("finishMeta");
  });

  it("renders generic meta as always-visible lines", () => {
    const a = loadAssets();
    expect(a.js).toContain("metaln");
    expect(a.css).toContain(".metaln");
    expect(a.css).toContain(".metaln.warn");
  });

  it("persists the active session in the URL and restores it on boot", () => {
    const a = loadAssets();
    expect(a.js).toContain("replaceState");
    expect(a.js).toContain('searchParams.set("session"');
    expect(a.js).toContain('searchParams.delete("session")');
    expect(a.js).toContain('URLSearchParams(location.search).get("session")');
    expect(a.js).toMatch(/openTab\(initialSession/);
    expect(a.js).toContain("if (!feedHasContent(tab.feed)) tab.historyLoaded = false;");
  });

  it("ships the first-run setup gate and wizard assets", () => {
    const a = loadAssets();
    expect(a.html).toContain('id="setupGate"');
    expect(a.html).toContain('src="/setup.js"');
    expect(a.setupJs).toBeTruthy();
    expect(a.css).toContain(".setup-gate");
    expect(a.css).toContain("body.setup-active");
  });

  it("wires the setup wizard to the /api/setup endpoints and app boot hook", () => {
    const a = loadAssets();
    expect(a.setupJs).toContain('window.MmaSetup');
    expect(a.setupJs).toContain('"/api/setup"');
    expect(a.setupJs).toContain('"/api/setup/scan"');
    expect(a.setupJs).toContain('"/api/setup/models"');
    expect(a.setupJs).toContain('"/api/setup/test"');
    expect(a.setupJs).toContain('"/api/setup/locale"');
    expect(a.js).toContain("window.MmaSetup");
  });
});
