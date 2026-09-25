import { describe, it, expect } from "vitest";
import { deriveSessionName, sanitizeTitle } from "../src/modules/session/auto-name";

describe("deriveSessionName", () => {
  it("uses the first non-empty line", () => {
    expect(deriveSessionName("\n\n  Fix the login bug \n more")).toBe("Fix the login bug");
  });
  it("strips markdown, inline code and urls", () => {
    expect(deriveSessionName("## Add `grep` tool to https://x.io/doc")).toBe("Add tool to");
  });
  it("strips trailing punctuation", () => {
    expect(deriveSessionName("Weather in Paris?")).toBe("Weather in Paris");
  });
  it("caps at word boundary with ellipsis", () => {
    const out = deriveSessionName("a".repeat(10) + " " + "b".repeat(80));
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out.endsWith("…")).toBe(true);
  });
  it("falls back to the date default when nothing remains", () => {
    expect(deriveSessionName("https://only-a-url.example", "2026-09-25")).toBe(
      "Session 2026-09-25",
    );
  });
});

describe("sanitizeTitle", () => {
  it("takes the first line and strips wraps/punctuation", () => {
    expect(sanitizeTitle('"Fix Login Bug."\nextra')).toBe("Fix Login Bug");
  });
  it("returns null for empty output", () => {
    expect(sanitizeTitle("  \n ")).toBeNull();
  });
});
