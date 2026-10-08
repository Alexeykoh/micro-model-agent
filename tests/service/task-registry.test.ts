import { describe, expect, it } from "vitest";
import { TaskRegistry, isTerminal } from "../../src/modules/service/runtime/task-registry";

function makeRegistry(now: () => number, overrides: Partial<{ retentionDays: number; idempotencyTtlHours: number }> = {}) {
  return new TaskRegistry({ retentionDays: 1, idempotencyTtlHours: 1, now, ...overrides });
}

describe("task registry", () => {
  it("tracks lifecycle and notifies waiters", async () => {
    const reg = makeRegistry(() => 1000);
    const task = reg.create({ sessionId: "s", mode: "job", input: "x" });
    expect(task.status).toBe("queued");
    expect(isTerminal(task.status)).toBe(false);

    const waiter = reg.whenFinished(task.jobId);
    reg.finish(task.jobId, { status: "succeeded", result: { text: "ok" } });
    const settled = await waiter;
    expect(settled?.status).toBe("succeeded");
    expect(settled?.finishedAt).toBe(new Date(1000).toISOString());
    expect(isTerminal(settled!.status)).toBe(true);
    expect(reg.get("nope")).toBeUndefined();
  });

  it("resolves immediately for an already-terminal task", async () => {
    const reg = makeRegistry(() => 0);
    const task = reg.create({ sessionId: "s", mode: "job", input: "x" });
    reg.finish(task.jobId, { status: "failed" });
    expect((await reg.whenFinished(task.jobId))?.status).toBe("failed");
  });

  it("dedupes idempotency keys with TTL and body-conflict", () => {
    let now = 1_000;
    const reg = makeRegistry(() => now);
    reg.recordIdempotency("p", "k", "hash-a", "job_1");
    expect(reg.checkIdempotency("p", "k", "hash-a")).toEqual({ kind: "hit", jobId: "job_1" });
    expect(reg.checkIdempotency("p", "k", "hash-b")).toEqual({ kind: "conflict" });
    now += 3_600_001; // TTL 1h expired
    expect(reg.checkIdempotency("p", "k", "hash-a")).toEqual({ kind: "miss" });
  });

  it("prunes terminal results past retention", () => {
    let now = 1_000;
    const reg = makeRegistry(() => now, { retentionDays: 1 });
    const old = reg.create({ sessionId: "s", mode: "job", input: "x" });
    reg.finish(old.jobId, { status: "succeeded" });
    const fresh = reg.create({ sessionId: "s", mode: "job", input: "y" });
    reg.finish(fresh.jobId, { status: "succeeded" });

    now += 86_400_001; // retention 1 day
    reg.prune();
    expect(reg.get(old.jobId)).toBeUndefined();
    // fresh was finished at 1000 too, so also pruned; re-check semantics:
    expect(reg.get(fresh.jobId)).toBeUndefined();
  });

  it("keeps a task that finished after the retention window", () => {
    let now = 1_000;
    const reg = makeRegistry(() => now, { retentionDays: 1 });
    const recent = reg.create({ sessionId: "s", mode: "job", input: "x" });
    now += 2 * 86_400_000; // two days later
    reg.finish(recent.jobId, { status: "succeeded" });
    reg.prune();
    expect(reg.get(recent.jobId)).toBeDefined();
  });
});
