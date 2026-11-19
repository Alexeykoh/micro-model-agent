import { describe, it, expect } from "vitest";
import { loadAssets } from "../src/modules/webui/assets";
import { getFlatDicts } from "../src/i18n/index";

/**
 * The sidebar's last tab launches MMART flight: a small Flappy-style break
 * with the real canvas mascot as the bird. Guards keep the launcher out of the
 * pane-tab list (TABS), make the modal keyboard-driven, and keep both locales
 * complete — the pieces a source-level test can pin down without a canvas.
 */
describe("MMART mini-game", () => {
  const a = loadAssets();
  const game = a.jsModules?.["js/game.js"] || "";
  const view = a.jsModules?.["js/game/view.js"] || "";
  const scene = a.jsModules?.["js/game/scene.js"] || "";
  const best = a.jsModules?.["js/game/best.js"] || "";
  const core = a.jsModules?.["js/sidebar/core.js"] || "";
  const composer = a.jsModules?.["js/composer-face.js"] || "";
  const loader = a.jsModules?.["js/loader.js"] || "";

  it("has no sidebar launch tab; the mascot is the only entry point", () => {
    expect(a.html).not.toContain('class="sb-tab sb-game"');
    expect(a.html).not.toContain('data-game="mmart"');
    // Pane switching, Alt+N and arrow navigation are driven by TABS; the game
    // is not a pane and not a sidebar action.
    const state = a.jsModules?.["js/sidebar/state.js"] || "";
    expect(state).not.toContain('"game"');
    expect(core).not.toContain("tab.dataset.game");
    expect(core).not.toContain("openGame()");
    expect(core).not.toContain("initGameTab");
    expect(core).not.toContain("syncGameTabI18n");
  });

  it("opens a themed modal with a blocky mascot drawn on the game canvas", () => {
    expect(view).toContain("game-overlay");
    expect(view).toContain("web.game.title");
    expect(view).not.toContain("game-bird");
    // Pixel art lives on the one canvas: no DOM mascot canvas (its aura used
    // to paint a square around the bird) and no antialiased rounded shapes.
    expect(game).not.toContain("attachMascot");
    expect(scene).toContain("drawMascot");
    expect(scene).not.toContain("roundRect");
    expect(scene).toContain("fillRect");
    expect(scene).toContain('"--accent"');
    expect(scene).toContain('"--bg"');
    expect(a.css).toContain(".game-overlay {");
    expect(a.css).toContain(".game-stage {");
    expect(a.css).toContain("image-rendering: pixelated");
    expect(a.css).not.toContain(".sb-tab.sb-game");
  });

  it("flashes red on a crash like the mascot's error state", () => {
    expect(scene).toContain("CRASH_LIFE");
    expect(scene).toContain("pal.red");
    expect(scene).toContain("crashT");
    expect(game).toContain("crashT += dt");
  });

  it("is playable from the keyboard and closes on Esc", () => {
    expect(game).toContain('key === "ArrowUp"');
    expect(game).toContain('key === "Spacebar"');
    expect(game).toContain('e.key === "Escape"');
    expect(game).toContain("closeGame()");
    expect(game).toContain("requestAnimationFrame");
    expect(best).toContain("localStorage");
  });

  it("opens from the composer mascot and no longer greets", () => {
    expect(composer).toContain("openGame");
    expect(composer).toContain('addEventListener("click"');
    expect(a.html).toContain('id="composerFace"');
    expect(a.html).not.toContain('id="composerFace" aria-hidden');
    // The old "Hi! I'm MMART" bubble is gone: no tip node, no handler, no copy.
    expect(loader).not.toContain("mdl-tip");
    expect(loader).not.toContain("showGreeting");
    expect(a.jsModules?.["js/app-i18n.js"] || "").not.toContain("setGreetResolver");
    expect(a.css).not.toContain(".mdl-tip");
  });

  it("has copy in both locales", () => {
    const dicts = getFlatDicts();
    for (const key of [
      "web.game.tab",
      "web.game.title",
      "web.game.score",
      "web.game.best",
      "web.game.ready",
      "web.game.over",
      "web.game.best_new",
      "web.game.close",
    ]) {
      expect(typeof dicts.en[key], `${key} (en)`).toBe("string");
      expect(typeof dicts.ru[key], `${key} (ru)`).toBe("string");
    }
  });
});
