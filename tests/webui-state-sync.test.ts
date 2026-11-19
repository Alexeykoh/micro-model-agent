import { describe, it, expect, beforeEach } from "vitest";
import { tabs, session } from "../src/modules/webui/assets/js/core/store/index.js";
import { routeState, storeSnapshot, mergeUsage, shouldHydrateAutoOpen } from "../src/modules/webui/assets/js/state-sync.js";

beforeEach(() => {
  tabs.tabs = [
    { id: "A", kind: "session" },
    { id: "B", kind: "session" },
  ];
  tabs.activeTabId = "A";
  session.host = {};
});

describe("state-sync", () => {
  it("routes a snapshot to its owner tab and flags active render", () => {
    expect(routeState({ sessionId: "A", state: { sessionId: "A", contextUsed: 1 } })).toBe(true);
    expect(tabs.tabs[0].state).toMatchObject({ contextUsed: 1 });
  });

  it("stores a background snapshot without flagging active render", () => {
    expect(routeState({ sessionId: "B", state: { sessionId: "B", contextUsed: 2 } })).toBe(false);
    expect(tabs.tabs[1].state).toMatchObject({ contextUsed: 2 });
  });

  it("never writes a foreign session's snapshot into another tab (guard)", () => {
    routeState({ sessionId: "B", state: { sessionId: "B", contextUsed: 9 } });
    expect(tabs.tabs[0].state).toBeUndefined();
  });

  it("merges usage only into the owner tab, mirroring the active one", () => {
    expect(mergeUsage("B", { contextUsed: 5 })).toBe(false);
    expect(tabs.tabs[1].state).toMatchObject({ contextUsed: 5 });
    expect(session.host).toEqual({});
    expect(mergeUsage("A", { contextUsed: 7 })).toBe(true);
    expect(session.host).toMatchObject({ contextUsed: 7 });
  });

  it("maps counters from a payload", () => {
    routeState({ busy: true, runningSessionIds: ["B"], queued: { B: 2 } });
    expect(session.runningSessionIds).toEqual(["B"]);
    expect(session.queued).toEqual({ B: 2 });
  });

  it("storeSnapshot writes to the matching tab", () => {
    expect(storeSnapshot({ sessionId: "B", contextUsed: 3 })).toBe("B");
    expect(tabs.tabs[1].state).toMatchObject({ contextUsed: 3 });
  });

  it("hydrates an auto-opened session only when it already has messages", () => {
    const sessions = [
      { id: "A", messageCount: 16 },
      { id: "B", messageCount: 0 },
      { id: "C" },
    ];
    expect(shouldHydrateAutoOpen(sessions, "A")).toBe(true);
    expect(shouldHydrateAutoOpen(sessions, "B")).toBe(false);
    // Unknown count / unknown session / no session → stay live (no fetch).
    expect(shouldHydrateAutoOpen(sessions, "C")).toBe(false);
    expect(shouldHydrateAutoOpen(sessions, "ghost")).toBe(false);
    expect(shouldHydrateAutoOpen(sessions, null)).toBe(false);
    expect(shouldHydrateAutoOpen(undefined, "A")).toBe(false);
  });
});
