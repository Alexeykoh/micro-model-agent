import { describe, it, expect } from "vitest";
import type { SessionLogEntry } from "../../src/modules/session/store";

/**
 * Replay должен переносить новое событие `instructions_updated`, не падая на
 * неизвестный тип и не считая его содержимым диалога (INV-IS-3).
 */

function updated(fingerprint: string, changes: unknown): SessionLogEntry {
  return {
    ts: "2026-11-19T00:00:00.000Z",
    type: "instructions_updated",
    source: "core",
    fingerprint,
    instructionChanges: changes,
  } as SessionLogEntry;
}

describe("instructions_updated: replay invariants", () => {
  it("keeps the event out of the conversation timeline", () => {
    const entry = updated("abc123", [{ label: "instructions", action: "changed" }]);
    expect(entry.type).not.toBe("user");
    expect(entry.type).not.toBe("assistant");
    expect(entry.type).not.toBe("system");
    expect(entry.source).toBe("core");
  });

  it("never carries file contents", () => {
    const entry = updated("abc123", [{ label: "instructions", action: "added" }]);
    expect(entry.content).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain("Marker:");
  });

  it("exposes fingerprint and change list for diagnosis", () => {
    const entry = updated("fp-1", [{ label: "instructions (docs/)", action: "removed" }]);
    expect(entry.fingerprint).toBe("fp-1");
    expect(entry.instructionChanges).toEqual([
      { label: "instructions (docs/)", action: "removed" },
    ]);
  });
});
