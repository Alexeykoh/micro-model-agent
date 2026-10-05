// Калибровка оценки контекста: baseline+delta, floor-ratio, shadow, stale, clamp.
import { describe, it, expect } from "vitest";
import {
  ContextCalibrator,
  isImplausibleJump,
} from "../../src/core/agent/context-calibration";

describe("ContextCalibrator", () => {
  it("returns raw while cold (no samples)", () => {
    const c = new ContextCalibrator();
    expect(c.getState()).toBe("cold");
    expect(c.calibrate(50000, 10)).toBe(50000);
  });

  it("stays on raw during warmup and becomes trusted after warmup calls", () => {
    const c = new ContextCalibrator({ warmup: 3 });
    c.observe(1000, 2000, 5);
    expect(c.getState()).toBe("warming");
    expect(c.calibrate(2000, 5)).toBe(2000); // warmup: пороги по raw
    c.observe(1100, 2000, 6);
    expect(c.getState()).toBe("warming");
    c.observe(1200, 2000, 7);
    expect(c.getState()).toBe("trusted");
  });

  it("baseline+delta corrects over-estimation without raising under-estimation", () => {
    const c = new ContextCalibrator({ warmup: 1 });
    // Провайдер отдал 9000 при сырой оценке 10000 (нормальное ~0.9× завышение).
    c.observe(9000, 10000, 23);
    expect(c.getState()).toBe("trusted");
    // Дальше raw вырос на 1000 → calibrated = 9000 + 1000.
    expect(c.calibrate(11000, 24)).toBe(10000);
  });

  it("never calibrates above raw (only reduces over-estimation)", () => {
    const c = new ContextCalibrator({ warmup: 1 });
    c.observe(20000, 10000, 10); // реально больше оценки
    // baseline.actual > estimated; delta для raw=10000 → 20000, но клампим к raw.
    expect(c.calibrate(10000, 10)).toBeLessThanOrEqual(10000);
  });

  it("floor-ratio prevents learning an inflated context as cheap", () => {
    const c = new ContextCalibrator({ warmup: 1, ratioFloor: 0.5, absoluteSlack: 20000 });
    c.observe(1000, 40000, 50); // провайдер молча усекает
    // calibrated не ниже max(50% raw, raw−20K) = 20000.
    expect(c.calibrate(40000, 50)).toBe(20000);
  });

  it("goes stale after more than one call without usage", () => {
    const c = new ContextCalibrator({ warmup: 1 });
    c.observe(1000, 2000, 1);
    expect(c.getState()).toBe("trusted");
    c.noteMissingUsage();
    expect(c.getState()).toBe("trusted"); // один промах терпим
    c.noteMissingUsage();
    expect(c.getState()).toBe("stale");
    expect(c.calibrate(2000, 1)).toBe(2000);
  });

  it("invalidate resets to stale and falls back to raw", () => {
    const c = new ContextCalibrator({ warmup: 1 });
    c.observe(1000, 2000, 1);
    c.invalidate();
    expect(c.getState()).toBe("stale");
    expect(c.calibrate(2000, 1)).toBe(2000);
  });

  it("ignores non-finite or zero actual usage", () => {
    const c = new ContextCalibrator({ warmup: 1 });
    c.observe(0, 2000, 1);
    expect(c.getState()).toBe("stale");
    c.observe(Number.NaN, 2000, 1);
    expect(c.getState()).toBe("stale");
  });

  it("getRatio reports the trusted baseline ratio", () => {
    const c = new ContextCalibrator({ warmup: 1 });
    c.observe(5000, 10000, 10);
    expect(c.getRatio()).toBeCloseTo(0.5, 5);
  });
});

describe("isImplausibleJump", () => {
  it("flags a >3x jump beyond the absolute slack with no message growth", () => {
    expect(isImplausibleJump(55600, 11500, 23, 21)).toBe(true);
  });

  it("does not flag when message count grew (large tool results)", () => {
    expect(isImplausibleJump(55600, 11500, 40, 21)).toBe(false);
  });

  it("does not flag moderate growth within the slack", () => {
    expect(isImplausibleJump(25000, 11500, 22, 21)).toBe(false);
  });

  it("does not flag when previous estimate is unknown", () => {
    expect(isImplausibleJump(99999, 0, 3, 0)).toBe(false);
  });
});
