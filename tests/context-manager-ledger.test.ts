import { describe, it, expect } from "vitest";
import { ContextManager } from "../src/modules/context/manager";
import { DEFAULTS } from "../src/config/defaults";

function seed(mgr: ContextManager) {
  mgr.addMessage({ role: "user", content: "research specialized bikes in minsk" } as any);
  mgr.addMessage({
    role: "tool",
    name: "web_search",
    content: "Specialized Minsk prices list",
    arguments: { query: "specialized minsk" },
  } as any);
  mgr.addMessage({
    role: "tool",
    name: "web_fetch",
    content: "Rockhopper page content with prices",
    arguments: { url: "https://velomarket.by/katalog" },
  } as any);
  for (let i = 0; i < 20; i++) mgr.addMessage({ role: "assistant", content: `step ${i}` } as any);
}

describe("ContextManager tool ledger", () => {
  it("pins a tool ledger across compactions", () => {
    const mgr = new ContextManager(32768);
    seed(mgr);
    const first = mgr.compact({ keepLastN: 2 });
    expect(first).toBeTruthy();
    expect(first!.summary).toContain("[Tool ledger]");
    expect(first!.summary).toContain("web_fetch(url)");
    expect(first!.summary).toContain("Rockhopper page content");

    // Вторая компакция не должна терять леджер, собранный ранее.
    for (let i = 0; i < 20; i++) mgr.addMessage({ role: "assistant", content: `more ${i}` } as any);
    const second = mgr.compact({ keepLastN: 2 });
    expect(second).toBeTruthy();
    expect(second!.summary).toContain("[Tool ledger]");
    expect(second!.summary).toContain("web_fetch");
  });

  it("omits the ledger when compactionSummary is off", () => {
    const mgr = new ContextManager(32768, {
      ...DEFAULTS.contextBudget,
      compactionSummary: "off",
    } as any);
    seed(mgr);
    const first = mgr.compact({ keepLastN: 2 });
    expect(first).toBeTruthy();
    expect(first!.summary).not.toContain("[Tool ledger]");
  });
});
