import { describe, expect, it } from "vitest";
import { EnvelopeLog, type Envelope } from "../../src/modules/service/runtime/envelope";

function env(sessionId: string, seq: number): Envelope {
  return { v: 1, seq, ts: 0, type: "text.delta", sessionId, data: { seq } };
}

describe("envelope log", () => {
  it("allocates monotonic per-session sequence", () => {
    const log = new EnvelopeLog();
    expect(log.next("a")).toBe(1);
    expect(log.next("a")).toBe(2);
    expect(log.next("b")).toBe(1);
  });

  it("returns only envelopes after the given seq", () => {
    const log = new EnvelopeLog();
    log.append(env("a", 1));
    log.append(env("a", 2));
    log.append(env("b", 1));
    expect(log.since("a", 0).map((e) => e.seq)).toEqual([1, 2]);
    expect(log.since("a", 1).map((e) => e.seq)).toEqual([2]);
    expect(log.since("a", 2)).toEqual([]);
  });

  it("evicts oldest beyond the cap and clears per session", () => {
    const log = new EnvelopeLog(2);
    log.append(env("a", 1));
    log.append(env("a", 2));
    log.append(env("a", 3));
    expect(log.since("a", 0).map((e) => e.seq)).toEqual([2, 3]);
    log.clear("a");
    expect(log.since("a", 0)).toEqual([]);
    expect(log.next("a")).toBe(1); // seq reset with the session
  });
});
