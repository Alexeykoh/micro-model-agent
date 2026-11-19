import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

setupHappyDom();

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: {
    "web.speed.tps": "{n} tok/s",
    "web.speed.estimated": "≈ {n} tok/s",
    "web.speed.title": "generation speed",
  },
};
const { resetSpeed, noteChunk, speedView, speedText } = await import(
  "../src/modules/webui/assets/js/speed.js"
);
const { renderSpeed, renderLiveSpeed, resetSpeedChip } = await import(
  "../src/modules/webui/assets/js/feed/speed-chip.js"
);
const { session } = await import("../src/modules/webui/assets/js/store.js");

const T0 = 1_000_000;

describe("generation speed", () => {
  beforeEach(() => {
    resetSpeed("s");
    resetSpeed("a");
    session.activeSessionId = null;
    session.runningSessionIds = [];
    session.busy = false;
  });

  it("estimates live tok/s from a rolling window", () => {
    // 400 chars = 100 tokens per second over a 1 s span.
    noteChunk("s", "x".repeat(400), T0);
    noteChunk("s", "x".repeat(200), T0 + 500);
    const view = speedView("s", T0 + 500);
    expect(view?.estimated).toBe(true);
    expect(view?.value ?? 0).toBeGreaterThan(0);
  });

  it("drops the live window after a pause", () => {
    noteChunk("s", "x".repeat(400), T0);
    expect(speedView("s", T0 + 2000)).toBeNull();
  });

  it("keeps sessions isolated", () => {
    noteChunk("a", "x".repeat(400), T0);
    expect(speedView("a", T0 + 500)?.value ?? 0).toBeGreaterThan(0);
    expect(speedView("b", T0 + 500)).toBeNull();
  });

  it("formats exact and estimated values", () => {
    expect(speedText(42.4, false)).toBe("42 tok/s");
    expect(speedText(5.55, true)).toBe("≈ 5.6 tok/s");
  });

  it("renders the final chip from the turn snapshot", () => {
    document.body.innerHTML = '<span id="speedChip" hidden></span>';
    renderSpeed({
      llmSpeed: {
        completionTokens: 100,
        decodeMs: 2000,
        calls: [{ completionTokens: 100, decodeMs: 2000, source: "api" }],
      },
    });
    const chip = document.getElementById("speedChip") as HTMLElement;
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toBe("50 tok/s");
    expect(chip.title).toBe("generation speed");
    renderSpeed({});
    expect(chip.hidden).toBe(true);
    expect(chip.textContent).toBe("");
  });

  it("has no per-call tooltip on the speed chip", () => {
    document.body.innerHTML = '<span id="speedChip" hidden></span>';
    renderSpeed({
      llmSpeed: {
        completionTokens: 100,
        decodeMs: 2000,
        calls: [{ completionTokens: 100, decodeMs: 2000, source: "api" }],
      },
    });
    const chip = document.getElementById("speedChip") as HTMLElement;
    chip.dispatchEvent(new Event("mouseenter"));
    expect(document.querySelector(".ctip.show")).toBeNull();
  });

  it("renders the live estimate in the same footer chip", () => {
    document.body.innerHTML = '<span id="speedChip" hidden></span>';
    session.activeSessionId = "s";
    session.runningSessionIds = ["s"];
    const now = Date.now();
    noteChunk("s", "x".repeat(400), now);
    noteChunk("s", "x".repeat(200), now + 100);
    renderLiveSpeed("s");
    const chip = document.getElementById("speedChip") as HTMLElement;
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toContain("tok/s");
  });

  it("ignores a background session and clears on tab change", () => {
    document.body.innerHTML = '<span id="speedChip" hidden></span>';
    session.activeSessionId = "a";
    session.runningSessionIds = ["a"];
    const now = Date.now();
    noteChunk("a", "x".repeat(400), now);
    renderLiveSpeed("a");
    const chip = document.getElementById("speedChip") as HTMLElement;
    expect(chip.hidden).toBe(false);
    // A chunk from another running session must not touch the active chip.
    renderLiveSpeed("b");
    expect(chip.hidden).toBe(false);
    resetSpeedChip();
    expect(chip.hidden).toBe(true);
  });
});
