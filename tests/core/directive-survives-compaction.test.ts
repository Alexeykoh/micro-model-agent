/**
 * W1.2: директивы харнесса переживают компакцию (§1.5 аудита).
 *
 * Компакция вырезает все `<system-summary>` из удерживаемого хвоста — то есть
 * и директивы. Стоящие директивы (реестр в `ContextManager`) возвращаются в
 * контекст после компакции, а снятые условием — нет.
 */
import { describe, expect, it } from "vitest";
import { ContextManager } from "../../src/core/context/manager";
import { clearDirective, issueDirective } from "../../src/core/agent/directives";

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
