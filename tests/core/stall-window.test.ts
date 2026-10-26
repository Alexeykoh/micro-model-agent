/**
 * W3 (spec 2026-10-26-session-visibility): окно неудач вместо серии.
 *
 * Разбор ses_mvpdchvi: 98 пакетов, 29 из них с неудачей, максимальная серия
 * подряд — 3. Существующие счётчики (`consecutiveFailedBatches`,
 * `consecutiveToolFailures`) сбрасываются любым успехом, поэтому чередование
 * «успех + фейл» не считалось топтанием и ход дошёл до 28 отказов без
 * эскалации. Здесь — окно из 8 пакетов (порог 5) и кумулятивный потолок.
 */
import { describe, expect, it } from "vitest";
import { ToolBatchExecutor } from "../../src/core/agent/tool-batch";
import { createLoopState } from "../../src/core/agent/loop-state";
import {
  MAX_FAILED_BATCHES_PER_TURN,
  STALL_FAILURES_IN_WINDOW,
  STALL_WINDOW,
} from "../../src/core/agent/constants";
import { makeToolBatchDeps } from "../helpers/tool-batch-deps";
import type { ToolResult } from "../../src/tools/types";

const OK: ToolResult = { success: true, output: "out" };
const FAIL: ToolResult = { success: false, output: "boom" };

/** Пакет с одним вызовом: `failing` — упал ли он; аргументы уникальны. */
function callN(n: number) {
  return [{ id: String(n), name: "bash", arguments: { command: `run ${n}` } }];
}

function makeExecutor(pattern: boolean[]) {
  const added: string[] = [];
  const events: string[] = [];
  let i = 0;
  const deps = makeToolBatchDeps({
    added,
    execute: () => (pattern[i++ % pattern.length] ? FAIL : OK),
  });
  const slog = {
    logAssistant: () => {},
    logToolCall: () => {},
    logDiagnosticEvent: (event: string) => events.push(event),
  };
  return { ex: new ToolBatchExecutor(deps), added, events, slog };
}

function stallDirectives(added: string[]): string[] {
  return added.filter(
    (m) => m.includes("going in circles") || m.includes("Ты топчешься"),
  );
}

/** Батч «говорит», чтобы W2-гард молчания не влиял на W3. */
const SAID = "проверяю очередной адрес";

describe("окно неудач", () => {
  it("эскалирует при чередовании успех/фейл (окно 8, порог 5)", async () => {
    // Всплеск отказов (5 из 8), как в реальной сессии: 29 неудачных пакетов
    // из 98, максимум 5 в окне 8. Серия подряд при этом — 3, поэтому
    // consecutive-счётчики молчат.
    const { ex, added, events, slog } = makeExecutor([
      true, true, true, true, true, false, false, false,
    ]);
    const state = createLoopState();
    const finals: Array<string | undefined> = [];
    for (let n = 0; n < STALL_WINDOW; n++) {
      state.iteration = n + 1;
      const out = await ex.execute(state, callN(n), new Set(), SAID, "", "task", undefined, undefined, slog as never);
      finals.push(out.finalize);
    }
    // Consecutive-счётчик сбрасывается успехом — он и не должен был сработать.
    expect(state.consecutiveFailedBatches).toBeLessThan(4);
    expect(stallDirectives(added).length).toBeGreaterThanOrEqual(1);
    expect(events).toContain("stall_detected");
    expect(finals.every((f) => f === undefined)).toBe(true);
  });

  it("жёстко останавливает ход после кумулятивного потолка неудач", async () => {
    const { ex } = makeExecutor([false, true]);
    const state = createLoopState();
    let finalize: string | undefined;
    for (let n = 0; n < MAX_FAILED_BATCHES_PER_TURN * 2 && !finalize; n++) {
      state.iteration = n + 1;
      finalize = (await ex.execute(state, callN(n), new Set(), SAID, "", "task")).finalize;
    }
    expect(finalize).toBe("stalled");
    expect(state.failedBatchesTotal).toBeGreaterThanOrEqual(MAX_FAILED_BATCHES_PER_TURN);
  });

  it("редкие неудачи в окне не эскалируют", async () => {
    const { ex, added } = makeExecutor([false, false, false, false, true]);
    const state = createLoopState();
    for (let n = 0; n < 20; n++) {
      state.iteration = n + 1;
      const out = await ex.execute(state, callN(n), new Set(), SAID, "", "task");
      expect(out.finalize).toBeUndefined();
    }
    expect(stallDirectives(added)).toEqual([]);
  });

  it("честный дебаг «упало → поправил» не попадает в окно", async () => {
    const { ex, added } = makeExecutor([true, true, false, false, false]);
    const state = createLoopState();
    for (let n = 0; n < 15; n++) {
      state.iteration = n + 1;
      const out = await ex.execute(state, callN(n), new Set(), SAID, "", "task");
      expect(out.finalize).toBeUndefined();
    }
    expect(stallDirectives(added)).toEqual([]);
    expect(state.failedBatchesTotal).toBeLessThan(MAX_FAILED_BATCHES_PER_TURN);
  });
});
