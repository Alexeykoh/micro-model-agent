// Queue identity + reordering in `RunPool`: cancel/start target a stable id,
// not a position that shifts when the head drains.
import { describe, it, expect } from "vitest";
import { RunPool } from "../src/modules/webui/session/session-pool";

function fill(pool: RunPool): { a: string; b: string; c: string } {
  const a = pool.enqueue("A", "a", [], "A");
  const b = pool.enqueue("A", "b", [], "A");
  const c = pool.enqueue("A", "c", [], "A");
  if (!a || !b || !c) throw new Error("queue unexpectedly full");
  return { a: a.id, b: b.id, c: c.id };
}

describe("RunPool queue controls", () => {
  it("returns a stable id for every queued message", () => {
    const pool = new RunPool(undefined, 5);
    const { a, b, c } = fill(pool);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(pool.queuedIds("A")).toEqual([a, b, c]);
    expect(pool.queuedIdsBySession()).toEqual({ A: [a, b, c] });
  });

  it("removes a message by id and rejects an unknown id", () => {
    const pool = new RunPool(undefined, 5);
    const { a, b, c } = fill(pool);
    expect(pool.removeQueued("A", b)?.text).toBe("b");
    expect(pool.queuedIds("A")).toEqual([a, c]);
    expect(pool.removeQueued("A", b)).toBeUndefined();
  });

  it("promotes a message to the head without reordering the rest", () => {
    const pool = new RunPool(undefined, 5);
    const { a, b, c } = fill(pool);
    expect(pool.promoteQueued("A", c)?.text).toBe("c");
    expect(pool.queuedIds("A")).toEqual([c, a, b]);
    // Promoting the head is a no-op for order.
    expect(pool.promoteQueued("A", c)?.text).toBe("c");
    expect(pool.queuedIds("A")).toEqual([c, a, b]);
  });
});
