// Seasonal weather overlay: emoji particles are randomized, rebuilt per theme
// and removed for non-seasonal themes.
import { beforeEach, describe, expect, it } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom();
const { applyThemeWeather } = await import("../src/modules/webui/assets/js/settings/weather.js");

beforeEach(() => {
  document.body.innerHTML = "";
});

const layer = (): HTMLElement | null => document.getElementById("themeWeather");

describe("theme weather", () => {
  it("builds a randomized emoji field for winter and autumn", () => {
    applyThemeWeather("winter");
    const snow = layer();
    expect(snow).toBeTruthy();
    expect(snow?.querySelectorAll(".wx-p").length).toBe(28);
    const snowText = snow?.textContent || "";
    expect(["❄️", "❅", "❆"].some((ch) => snowText.includes(ch))).toBe(true);

    applyThemeWeather("autumn");
    const leaves = layer();
    expect(leaves?.querySelectorAll(".wx-p").length).toBe(22);
    const leafText = leaves?.textContent || "";
    expect(["🍁", "🍂", "🍃"].some((ch) => leafText.includes(ch))).toBe(true);
  });

  it("clears the field for non-seasonal themes", () => {
    applyThemeWeather("autumn");
    applyThemeWeather("console");
    expect(layer()?.hidden).toBe(true);
    expect(layer()?.querySelectorAll(".wx-p").length).toBe(0);
  });

  it("does not rebuild when the same theme is applied twice", () => {
    applyThemeWeather("winter");
    const first = layer()?.querySelector(".wx-p");
    applyThemeWeather("winter");
    expect(layer()?.querySelector(".wx-p")).toBe(first);
  });
});
