// Guard: fmtTokens для миллионов даёт M, а не четырёхзначный K.
//
// Регресс из живой сессии ses_mw88khb4: накопленные входные токены
// 2 760 466 печатались как «2760.5K» — читается как буквальные 2760000
// и не следует стандартному K/M/B формату.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

setupHappyDom(`<div id="x"></div>`);

const { fmtTokens } = await import("../src/modules/webui/assets/js/format");

describe("fmtTokens", () => {
  it("keeps small numbers plain", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
  });

  it("formats thousands with K", () => {
    expect(fmtTokens(1000)).toBe("1.0K");
    expect(fmtTokens(15397)).toBe("15.4K");
    expect(fmtTokens(999949)).toBe("999.9K");
  });

  it("rounds the top of a tier into the next unit", () => {
    expect(fmtTokens(999999)).toBe("1.0M");
    expect(fmtTokens(999_999_999)).toBe("1.0B");
  });

  it("formats millions with M, not four-digit K", () => {
    expect(fmtTokens(1_000_000)).toBe("1.0M");
    expect(fmtTokens(2_760_466)).toBe("2.8M");
    expect(fmtTokens(55_156)).toBe("55.2K");
  });

  it("formats billions with B", () => {
    expect(fmtTokens(1_250_000_000)).toBe("1.3B");
  });
});
