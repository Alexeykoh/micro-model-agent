/**
 * Пастнутый ввод: readline эмитит строки подряд, не дожидаясь async-хендлера.
 * Без очереди вторая команда обгоняла первую (вывод перемешивался), а `/exit`
 * мог закрыть REPL посреди работы предыдущей команды.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Repl } from "../../src/cli/repl";
import { makeCaptureChannel, type CaptureChannel } from "./capture-channel";
import { makeBareRepl } from "./repl-fixtures";

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("REPL: очередь ввода", () => {
  let dir: string;
  let capture: CaptureChannel;
  let repl: Repl | undefined;

  beforeEach(() => {
    process.env.MMA_DSR = "0";
    dir = mkdtempSync(join(tmpdir(), "mma-input-queue-"));
    capture = makeCaptureChannel();
  });

  afterEach(() => {
    (repl as unknown as { rl?: { close?: () => void } } | undefined)?.rl?.close?.();
    repl = undefined;
    capture.channel.dispose();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MMA_DSR;
  });

  it("вывод команд идёт в порядке ввода, а не завершения", async () => {
    repl = makeBareRepl({
      channel: capture.channel,
      historyPath: join(dir, "repl-history"),
    });
    repl.registerCommand({
      name: "slow",
      description: "slow test command",
      action: async () => {
        await tick(40);
        capture.out.data += "slow\n";
      },
    });
    repl.registerCommand({
      name: "fast",
      description: "fast test command",
      action: () => {
        capture.out.data += "fast\n";
      },
    });

    const rl = (repl as unknown as { rl: { emit: (event: string, line: string) => void } }).rl;
    rl.emit("line", "/slow");
    rl.emit("line", "/fast");

    await tick(150);
    expect(capture.out.data).toBe("slow\nfast\n");
  });
});
