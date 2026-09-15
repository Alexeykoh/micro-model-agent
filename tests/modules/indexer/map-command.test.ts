import { describe, it, expect } from "vitest";
import { runMapAction } from "../../../src/modules/indexer/map-command";
import type { IndexerModule } from "../../../src/modules/indexer/module";

function stub(overrides: Partial<IndexerModule> = {}): IndexerModule {
  return {
    buildIndex: async () => ({ files: [], totalSize: 0 }),
    refresh: async () => ({ files: [], totalSize: 0 }),
    getPromptMap: () => "MAP CONTENT",
    formatFind: (q: string) => `FIND:${q}`,
    ...overrides,
  } as unknown as IndexerModule;
}

describe("runMapAction", () => {
  it("summary returns the prompt map", async () => {
    const r = await runMapAction(stub(), "summary");
    expect(r.ok).toBe(true);
    expect(r.output).toBe("MAP CONTENT");
  });

  it("defaults to summary for an unknown action", async () => {
    const r = await runMapAction(stub(), "bogus");
    expect(r.output).toBe("MAP CONTENT");
  });

  it("reports not-indexed when there is no index", async () => {
    const r = await runMapAction(stub({ buildIndex: async () => null }), "summary");
    expect(r.ok).toBe(false);
    expect(r.output).toContain("not");
  });

  it("find requires a query", async () => {
    const r = await runMapAction(stub(), "find", "  ");
    expect(r.ok).toBe(false);
  });

  it("find delegates to formatFind", async () => {
    const r = await runMapAction(stub(), "find", "agent");
    expect(r.ok).toBe(true);
    expect(r.output).toBe("FIND:agent");
  });

  it("refresh re-indexes and prefixes the map", async () => {
    let refreshed = false;
    const r = await runMapAction(
      stub({
        refresh: async () => {
          refreshed = true;
          return { files: [], totalSize: 0 };
        },
      }),
      "refresh",
    );
    expect(refreshed).toBe(true);
    expect(r.output).toContain("MAP CONTENT");
  });
});
