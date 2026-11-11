/**
 * W1.2: директивы харнесса переживают компакцию (§1.5 аудита).
 *
 * Компакция вырезает все `<system-summary>` из удерживаемого хвоста — то есть
 * и директивы. Стоящие директивы (реестр в `ContextManager`) возвращаются в
 * контекст после компакции, а снятые условием — нет.
 */
import { describe, expect, it } from "vitest";
import { ContextManager } from "../../src/core/context/manager";
import {
  clearDirective,
  issueDirective,
  type DirectiveSink,
} from "../../src/core/agent/directives";

/** Контекст с достаточным числом сообщений, чтобы компакция что-то сделала. */
function makeContext(): ContextManager {
  const cm = new ContextManager(32768);
  cm.addMessage({ role: "system", content: "sys" });
  for (let i = 0; i < 40; i++) {
    cm.addMessage({ role: "user", content: `task ${i} `.repeat(200) });
    cm.addMessage({ role: "assistant", content: `answer ${i} `.repeat(200) });
  }
  return cm;
}

describe("standing directives", () => {
  it("returns a directive to the context after compaction", () => {
    const cm = makeContext();
    issueDirective(cm, "failed_batches", "STOP retrying and answer now");
    const before = cm.getActiveHistory().length;
    cm.compact();
    const after = cm.getActiveHistory();
    expect(after.length).toBeLessThan(before);
    const texts = after.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(texts).toContain("STOP retrying and answer now");
  });

  it("does not re-add a directive whose condition was cleared", () => {
    const cm = makeContext();
    issueDirective(cm, "duplicate", "Stop repeating the same call");
    clearDirective(cm, "duplicate");
    cm.compact();
    const texts = cm
      .getActiveHistory()
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(texts).not.toContain("Stop repeating the same call");
  });

  it("keeps the directive list inspectable and clearable as a whole", () => {
    const cm = makeContext();
    issueDirective(cm, "research", "Converge the search");
    issueDirective(cm, "cycle", "Stop polishing");
    expect([...cm.standingDirectives.keys()].sort()).toEqual(["cycle", "research"]);
    cm.standingDirectives.clear();
    expect(cm.standingDirectives.size).toBe(0);
  });
});

describe("supersedeDirective (S4)", () => {
  const needle = "<system-summary>STOP retrying and answer now</system-summary>";

  it("removes the directive text from the active history when cleared", () => {
    const cm = new ContextManager(32768);
    cm.addMessage({ role: "system", content: "sys" });
    issueDirective(cm, "failed_batches", "STOP retrying and answer now");
    expect(cm.getActiveHistory().some((m) => m.content === needle)).toBe(true);

    clearDirective(cm, "failed_batches");
    expect(cm.getActiveHistory().some((m) => m.content === needle)).toBe(false);
    expect(cm.standingDirectives.has("failed_batches")).toBe(false);
  });

  it("keeps assistant(tool_calls)↔tool pairs intact", () => {
    const cm = new ContextManager(32768);
    cm.addMessage({ role: "system", content: "sys" });
    cm.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
    });
    cm.addMessage({ role: "tool", tool_call_id: "c1", content: "out" });
    issueDirective(cm, "failed_batches", "STOP retrying and answer now");
    clearDirective(cm, "failed_batches");

    const hist = cm.getActiveHistory();
    const ai = hist.findIndex((m) => m.role === "assistant" && m.tool_calls);
    expect(ai).toBeGreaterThan(-1);
    expect(hist[ai + 1]?.role).toBe("tool");
    expect(hist[ai + 1]?.tool_call_id).toBe("c1");
  });

  it("clearDirective supersedes before clearing the standing registry", () => {
    const calls: string[] = [];
    const sink: DirectiveSink = {
      addMessage: () => {},
      setStandingDirective: () => {},
      clearStandingDirective: () => calls.push("clear"),
      supersedeDirective: () => calls.push("supersede"),
    };
    clearDirective(sink, "duplicate");
    expect(calls).toEqual(["supersede", "clear"]);
  });
});
