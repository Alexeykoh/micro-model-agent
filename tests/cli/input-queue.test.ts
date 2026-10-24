import { describe, it, expect } from "vitest";
import { InputQueue } from "../../src/cli/input-queue";

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("InputQueue: строки ввода выполняются строго по очереди", () => {
  it("медленная первая задача не пропускает вторую вперёд", async () => {
    const q = new InputQueue();
    const seen: string[] = [];

    q.push(async () => {
      await tick(30);
      seen.push("slow");
    });
    q.push(() => {
      seen.push("fast");
    });
    q.push(async () => {
      await tick(5);
      seen.push("third");
    });

    await q.idle();
    expect(seen).toEqual(["slow", "fast", "third"]);
  });

  it("ошибка задачи уходит в onError и очередь продолжает работу", async () => {
    const errors: unknown[] = [];
    const q = new InputQueue((err) => errors.push(err));
    let ran = false;

    q.push(() => {
      throw new Error("boom");
    });
    q.push(() => {
      ran = true;
    });

    await q.idle();
    expect(ran).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it("idle() ждёт последнюю задачу, добавленную до вызова", async () => {
    const q = new InputQueue();
    let done = false;
    q.push(async () => {
      await tick(10);
      done = true;
    });

    await q.idle();
    expect(done).toBe(true);
  });
});
