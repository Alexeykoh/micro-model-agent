// Единое форматирование длительности: все поверхности web UI обязаны
// показывать минуты после 60 с, а не «125.4s».
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

setupHappyDom(`<div id="msgs" class="msgs"></div>`);

const dur = await import("../src/modules/webui/assets/js/duration.js");
const fmt = await import("../src/modules/webui/assets/js/format.js");
const stream = await import("../src/modules/webui/assets/js/feed/stream.js");

describe("web UI duration formatting", () => {
  it("keeps milliseconds and seconds below the minute threshold", () => {
    expect(dur.formatDuration(0)).toBe("0ms");
    expect(dur.formatDuration(500)).toBe("500ms");
    expect(dur.formatDuration(1500)).toBe("1.5s");
    expect(dur.formatDuration(59_900)).toBe("59.9s");
  });

  it("switches to minutes at 60 seconds", () => {
    expect(dur.formatDuration(60_000)).toBe("1m 00s");
    expect(dur.formatDuration(65_400)).toBe("1m 05s");
    expect(dur.formatDuration(125_000)).toBe("2m 05s");
  });

  it("switches to hours after an hour", () => {
    expect(dur.formatDuration(3_661_000)).toBe("1h 01m 01s");
  });

  it("returns an empty string for invalid values", () => {
    expect(dur.formatDuration(null)).toBe("");
    expect(dur.formatDuration(undefined)).toBe("");
    expect(dur.formatDuration(Number.NaN)).toBe("");
  });

  it("formats seconds passed from second-based callers", () => {
    expect(dur.formatSeconds(65)).toBe("1m 05s");
  });

  it("legacy formatMs delegates to the shared formatter", () => {
    expect(fmt.formatMs(65_000)).toBe("1m 05s");
  });

  it("think block header uses minutes too", () => {
    const t0 = 1_000_000;
    expect(stream.thinkDurText(t0, t0 + 125_000)).toBe("· 2m 05s");
  });

  it("threshold constant documents the switch point", () => {
    expect(dur.DURATION_THRESHOLDS.MINUTE).toBe(60_000);
  });
});
