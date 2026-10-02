import { describe, it, expect } from "vitest";
import type { ServerResponse } from "node:http";
import { createWebUiState } from "../src/modules/webui/state";
import { installOutputForwarding } from "../src/modules/webui/log-forward";
import { OutputBus } from "../src/output/bus";

/** Minimal SSE client: broadcast only calls `write`/`end`. */
function fakeClient(chunks: string[]): ServerResponse {
  return {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: () => {},
  } as unknown as ServerResponse;
}

/** One wired forwarder: a web state with a single chunk-collecting client. */
function setupForwarding(): { chunks: string[]; bus: OutputBus; off: () => void } {
  const chunks: string[] = [];
  const s = createWebUiState();
  s.clients.add(fakeClient(chunks));
  const bus = new OutputBus();
  const off = installOutputForwarding(s, bus);
  return { chunks, bus, off };
}

describe("webui log forwarding", () => {
  it("broadcasts OutputBus warn events as `log` SSE events", () => {
    const { chunks, bus, off } = setupForwarding();

    bus.log("warn", "probe.context", "system prompt overflow");

    const wire = chunks.join("");
    expect(wire).toContain("event: log");
    expect(wire).toContain('"level":"warn"');
    expect(wire).toContain('"source":"probe.context"');
    expect(wire).toContain("system prompt overflow");

    off();
    bus.log("warn", "probe.context", "after unsubscribe");
    expect(chunks.join("")).not.toContain("after unsubscribe");
  });

  it("redacts secrets in forwarded log text", () => {
    const { chunks, bus } = setupForwarding();

    bus.log("error", "mma", "token sk-1234567890abcdefghij leaked");

    const wire = chunks.join("");
    expect(wire).not.toContain("sk-1234567890abcdefghij");
    expect(wire).toContain("[REDACTED]");
  });

  it("drops debug-level events", () => {
    const { chunks, bus } = setupForwarding();

    bus.log("debug", "mma", "noise");

    expect(chunks.join("")).not.toContain("noise");
  });

  it("carries the diagnostic flag so the client hides it outside verbose", () => {
    const { chunks, bus } = setupForwarding();

    bus.log("info", "agent", "internal retry 1/3", { diagnostic: true });
    bus.log("warn", "probe.context", "system prompt overflow");

    const wire = chunks.join("");
    expect(wire).toContain('"diagnostic":true');
    expect(wire).toContain('"diagnostic":false');
    expect(wire.split('"diagnostic":true')).toHaveLength(2);
  });

  it("preserves the event's own sessionId instead of the last-active one", () => {
    const chunks: string[] = [];
    const s = createWebUiState();
    s.clients.add(fakeClient(chunks));
    s.activeSessionId = "ses_MAIN";
    const bus = new OutputBus();
    const off = installOutputForwarding(s, bus);

    bus.emit({
      level: "warn",
      source: "agent",
      kind: "log",
      text: "background warning",
      sessionId: "ses_B",
    });

    const wire = chunks.join("");
    expect(wire).toContain('"sessionId":"ses_B"');
    expect(wire).not.toContain('"sessionId":"ses_MAIN"');
    off();
  });
});
