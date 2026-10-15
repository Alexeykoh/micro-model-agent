import { describe, it, expect } from "vitest";
import { admissionDiagnosticSink } from "../../src/core/bootstrap/tool-context";
import type { SessionManager } from "../../src/modules/session/manager";

/**
 * Gate for the admission fail-open sink (INV-15, W10.4).
 *
 * The `Diagnostic` object emitted by `admitFromContext` was covered, but the
 * sink that persists it as an `admission_degraded` record was not called by any
 * test: a signal that is constructed correctly and then dropped on the way to
 * `session.jsonl` is exactly the "works on my machine" shape of a fail-open.
 */

interface LoggedRecord {
  type: string;
  source?: string;
  operation?: string;
  errorKind?: string;
  cause?: string;
}

function fakeManager(): { manager: SessionManager; records: LoggedRecord[] } {
  const records: LoggedRecord[] = [];
  const manager = {
    appendLog: (entry: LoggedRecord) => records.push(entry),
  } as unknown as SessionManager;
  return { manager, records };
}

describe("admissionDiagnosticSink (INV-15)", () => {
  it("persists the diagnostic as an admission_degraded record", () => {
    const { manager, records } = fakeManager();
    const sink = admissionDiagnosticSink(manager);
    sink({
      source: "tool:admission",
      operation: "admit",
      kind: "degraded",
      cause: "ENOTDIR: not a directory",
      recoverable: true,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "admission_degraded",
      source: "tool:admission",
      operation: "admit",
      errorKind: "degraded",
      cause: "ENOTDIR: not a directory",
    });
    // `content` = cause: старые читатели Trace видят причину без новых полей.
    const record = records[0] as LoggedRecord & { content?: string };
    expect(record.content).toBe("ENOTDIR: not a directory");
  });

  it("writes the judge degradation under its own signature, not as admission", () => {
    // Два разных отказа, записанные под одним именем, в разборе сессии
    // неразличимы: «не влезло в бюджет» и «судья молчала» слиплись бы в одно.
    const { manager, records } = fakeManager();
    admissionDiagnosticSink(manager, "hallucination_judge_degraded")({
      source: "core",
      operation: "hallucination.judge",
      kind: "degraded",
      cause: "provider exploded",
      recoverable: true,
    });
    expect(records[0]).toMatchObject({
      type: "hallucination_judge_degraded",
      source: "core",
      operation: "hallucination.judge",
      cause: "provider exploded",
    });
  });

  it("falls back to the operation when the diagnostic carries no cause", () => {
    const { manager, records } = fakeManager();
    admissionDiagnosticSink(manager)({ source: "core", operation: "context.compaction", kind: "ok" });
    expect(records[0].content).toBe("context.compaction");
  });
});