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
    "web.speed.total": "{tokens} tokens in {sec}s",
    "web.speed.call": "#{n} · {tokens} tokens · {sec}s · {rate} tok/s",
    "web.speed.estimate_note": "≈ estimated from streamed characters",
  },
};
const { resetSpeed, noteChunk, speedView, speedText } = await import(
  "../src/modules/webui/assets/js/speed.js"
);
const { renderSpeed } = await import("../src/modules/webui/assets/js/feed/speed-chip.js");

const T0 = 1_000_000;

describe("generation speed", () => {
  beforeEach(() => resetSpeed("s"));

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
});
