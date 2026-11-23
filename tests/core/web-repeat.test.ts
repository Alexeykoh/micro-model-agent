// Гвард к docs/specs/2026-11-23-research-loop-efficiency-design.md (§6):
// девять web_fetch на разные URL одного домена не считались дублями.
import { describe, it, expect, beforeEach } from "vitest";
import { recordWebFetchHost, resetWebRepeat, WEB_REPEAT_WASTE_THRESHOLD } from "../../src/core/agent/web-repeat";

beforeEach(() => resetWebRepeat());

describe("web repeat waste", () => {
  it("counts only repeat loads of the same host", () => {
    expect(WEB_REPEAT_WASTE_THRESHOLD).toBe(3);
    expect(recordWebFetchHost("https://www.gym24.by/stoimost/")).toBe(false);
    expect(recordWebFetchHost("https://www.gym24.by/abonementy/")).toBe(false);
    expect(recordWebFetchHost("https://www.gym24.by/")).toBe(false);
    expect(recordWebFetchHost("https://www.gym24.by/stoimost/")).toBe(true);
  });

  it("does not mix different hosts and ignores malformed URLs", () => {
    recordWebFetchHost("https://www.gym24.by/a");
    recordWebFetchHost("https://gym24.relax.by/pricing/");
    expect(recordWebFetchHost("https://gym24.103.by/pricing/")).toBe(false);
    expect(recordWebFetchHost("not a url")).toBe(false);
  });
});
