/**
 * W2 (spec 2026-10-26-session-visibility): шаг обязан быть слышен.
 *
 * Разбор ses_mvpdchvi: 98 ответов ассистента, из них 1 с текстом, 155 вызовов
 * тулов — пользователь видел только строки тулов и дважды прервал ход.
 * Тест держит три вещи: правило в промпте, директиву после серии молчаливых
 * пакетов и жёсткий терминал молчания.
 */
import { describe, expect, it } from "vitest";
import { ToolBatchExecutor } from "../../src/core/agent/tool-batch";
import { createLoopState } from "../../src/core/agent/loop-state";
import {
  HARD_STOP_SILENT_BATCHES,
  NARRATION_DIRECTIVE_AFTER_SILENT_BATCHES,
} from "../../src/core/agent/constants";
import { buildSystemInfo } from "../../src/core/system-prompt";
import { makeToolBatchDeps } from "../helpers/tool-batch-deps";

/** Разные вызовы: иначе duplicate-терминал (12) сработает раньше silent (14). */
function callAt(i: number) {
  return [{ id: String(i), name: "bash", arguments: { command: `docker ps --filter id=${i}` } }];
}

async function runBatches(texts: string[], added: string[]) {
  const deps = makeToolBatchDeps({ added });
  const ex = new ToolBatchExecutor(deps);
  const state = createLoopState();
  const finals: Array<string | undefined> = [];
  for (const [i, text] of texts.entries()) {
    state.iteration = i + 1;
    const out = await ex.execute(
      state,
      callAt(i),
      new Set(),
      text,
      "",
      "task",
      undefined,
      undefined,
    );
    finals.push(out.finalize);
  }
  return { state, finals };
}

/** Текст директивы нарратива (в `<system-summary>`, локаль не фиксируем). */
function narrationDirectives(added: string[]): string[] {
  return added.filter(
    (m) => m.includes("You have not said anything") || m.includes("не сказал пользователю ни слова"),
  );
}

describe("нарратив шага", () => {
  it("выдаёт директиву после серии молчаливых пакетов", async () => {
    const added: string[] = [];
    const { state } = await runBatches(
      Array.from({ length: NARRATION_DIRECTIVE_AFTER_SILENT_BATCHES }, () => ""),
      added,
    );
    expect(narrationDirectives(added).length).toBe(1);
    expect(state.narrationNudged).toBe(true);
  });

  it("не выдаёт директиву, пока модель говорит", async () => {
    const added: string[] = [];
    const { state, finals } = await runBatches(
      Array.from({ length: HARD_STOP_SILENT_BATCHES + 4 }, () => "читаю конфиг контейнера"),
      added,
    );
    expect(narrationDirectives(added)).toEqual([]);
    expect(state.consecutiveSilentBatches).toBe(0);
    expect(finals.some((f) => f === "silent")).toBe(false);
  });

  it("короткая отписка «ok» не считается нарративом", async () => {
    const added: string[] = [];
    const { state } = await runBatches(["ok", "ok", "ok"], added);
    expect(state.consecutiveSilentBatches).toBe(3);
    expect(narrationDirectives(added).length).toBe(1);
  });

  it("пакет с текстом сбрасывает серию", async () => {
    const added: string[] = [];
    const { state } = await runBatches(["", "", "проверяю сеть", "", ""], added);
    // Серия после текста — 2, порог директивы (3) не достигнут.
    expect(state.consecutiveSilentBatches).toBe(2);
    expect(narrationDirectives(added)).toEqual([]);
  });

  it("жёстко останавливает ход после серии молчания", async () => {
    const added: string[] = [];
    const { state, finals } = await runBatches(
      Array.from({ length: HARD_STOP_SILENT_BATCHES }, () => ""),
      added,
    );
    expect(finals.at(-1)).toBe("silent");
    expect(state.consecutiveSilentBatches).toBe(HARD_STOP_SILENT_BATCHES);
  });
});

describe("правило нарратива в системном промпте", () => {
  it("требует говорить, что агент делает", () => {
    const prompt = buildSystemInfo({ model: "test-model" } as never, "/tmp", "win32");
    expect(prompt).toContain("NARRATION");
    expect(prompt).toMatch(/what you are doing and why/i);
    expect(prompt).toMatch(/3 tool batches in a row/i);
  });
});
