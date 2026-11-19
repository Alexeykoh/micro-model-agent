import { describe, it, expect } from "bun:test";
import { fallbackPromptFacts, localNow } from "../../src/core/prompt-facts";
import { buildSystemInfo } from "../../src/core/system-prompt";
import { DEFAULTS } from "../../src/config/defaults";

describe("client timezone (B18)", () => {
  it("renders client time shifted by its offset and marks it as the user's", () => {
    // 12:00Z при +05:00 → 17:00 у пользователя.
    const now = localNow(new Date("2026-10-31T12:00:00Z"), {
      timeZone: "Asia/Yekaterinburg",
      utcOffset: "+05:00",
    });
    expect(now.source).toBe("client");
    expect(now.iso).toContain("17:00:00 +05:00");
    expect(now.timeZone).toBe("Asia/Yekaterinburg");
  });

  it("falls back to server time on a malformed override", () => {
    const now = localNow(new Date("2026-10-31T12:00:00Z"), {
      timeZone: "",
      utcOffset: "banana",
    });
    expect(now.source).toBe("server");
  });

  it("marks server time in the prompt so the model does not trust a foreign zone", () => {
    const text = buildSystemInfo(structuredClone(DEFAULTS), "/tmp", "linux");
    expect(text).toContain("(server local time)");
  });

  it("marks client time as the user's", () => {
    const base = fallbackPromptFacts(structuredClone(DEFAULTS), "/tmp", "linux", {
      timeZone: "Asia/Yekaterinburg",
      utcOffset: "+05:00",
    });
    const text = buildSystemInfo(structuredClone(DEFAULTS), "/tmp", "linux", base);
    expect(text).toContain("(user local time)");
    expect(text).not.toContain("(server local time)");
  });
});
