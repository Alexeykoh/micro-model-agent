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

describe("webui log forwarding", () => {
  it("broadcasts OutputBus warn events as `log` SSE events", () => {
    const s = createWebUiState();
    const chunks: string[] = [];
    s.clients.add(fakeClient(chunks));
    const bus = new OutputBus();
    const off = installOutputForwarding(s, bus);

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
    const s = createWebUiState();
    const chunks: string[] = [];
    s.clients.add(fakeClient(chunks));
    const bus = new OutputBus();
    installOutputForwarding(s, bus);

    bus.log("error", "mma", "token sk-1234567890abcdefghij leaked");

    const wire = chunks.join("");
    expect(wire).not.toContain("sk-1234567890abcdefghij");
    expect(wire).toContain("[REDACTED]");
  });

  it("drops debug-level events", () => {
    const s = createWebUiState();
    const chunks: string[] = [];
    s.clients.add(fakeClient(chunks));
    const bus = new OutputBus();
    installOutputForwarding(s, bus);

    bus.log("debug", "mma", "noise");

    expect(chunks.join("")).not.toContain("noise");
  });
});
