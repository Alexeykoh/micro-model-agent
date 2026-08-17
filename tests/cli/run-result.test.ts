import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printRunResult } from "../../src/cli/run-result";
import { setLocale } from "../../src/i18n/index";

describe("printRunResult", () => {
  beforeEach(() => {
    setLocale("en");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 1 and prints ONLY the error on failure (not the stale text)", () => {
    const code = printRunResult(
      {
        success: false,
        text: "Task done!",
        error: "Model returned insufficient responses",
      },
      vi.fn(),
    );
    expect(code).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Model returned insufficient responses"),
    );
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Task done!"));
  });

  it("returns 0 and warns when a successful run produced no text", () => {
    const code = printRunResult({ success: true, text: "" }, vi.fn());
    expect(code).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("produced no output"));
  });

  it("returns 0 on success without extra output", () => {
    const code = printRunResult({ success: true, text: "stale-text-marker-xyz" }, vi.fn());
    expect(code).toBe(0);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("stale-text-marker-xyz"));
  });
});
