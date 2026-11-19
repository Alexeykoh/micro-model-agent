import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MemoryStore } from "../src/modules/memory/store";

function storeWith(dir: string, days: number) {
  return new MemoryStore(dir, { enabled: false }, { retentionDays: days });
}

describe("memory TTL (durable state 4/4)", () => {
  it("hides expired entries on read, keeps fresh and manual lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-memttl-"));
    const store = storeWith(dir, 30);
    writeFileSync(
      join(dir, "facts.md"),
      [
        "# Facts",
        "",
        "- **2026-01-01 09:00:00** — old fact",
        "- **2026-11-01 09:00:00** — fresh fact",
        "- **bad date** — manual note kept without expiry",
        "",
      ].join("\n"),
      "utf-8",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = store.read("facts");
    expect(text).toContain("fresh fact");
    expect(text).toContain("manual note kept");
    expect(text).not.toContain("old fact");
  });

  it("pruneExpired physically removes expired entries, keeps encrypted-style lines intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-memttl-"));
    const store = storeWith(dir, 30);
    writeFileSync(
      join(dir, "facts.md"),
      [
        "# Facts",
        "",
        "- **2026-01-01 09:00:00** — [enc]b2xk[/enc]",
        "- **2026-11-01 09:00:00** — [enc]ZnJlc2g=[/enc]",
        "",
      ].join("\n"),
      "utf-8",
    );
    const removed = store.pruneExpired("facts");
    expect(removed).toBe(1);
    const after = readFileSync(join(dir, "facts.md"), "utf-8");
    expect(after).toContain("[enc]ZnJlc2g=[/enc]");
    expect(after).not.toContain("[enc]b2xk[/enc]");
  });

  it("disabled retention (0) keeps everything", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-memttl-"));
    const store = storeWith(dir, 0);
    writeFileSync(join(dir, "facts.md"), "# Facts\n\n- **2026-01-01 09:00:00** — old fact\n", "utf-8");
    expect(store.read("facts")).toContain("old fact");
    expect(store.pruneExpired("facts")).toBe(0);
  });
});
