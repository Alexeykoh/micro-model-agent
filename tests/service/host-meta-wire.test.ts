/**
 * W9: паритет мета-канала по wire. Демон должен доставлять thin-клиенту те же
 * `meta`/`retract`/`critic` события, что локальный REPL видит из `onMeta`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult, MetaKind, RetractInfo } from "../../src/core/types";
import { startAgentService } from "../../src/modules/service/module";
import { RemoteHost } from "../../src/modules/daemon/remote-host";
import type { HostEvent } from "../../src/core/host";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./harness";

let dir: string;
let stop: (() => void) | undefined;

function metaAgent(report: Record<string, unknown>): unknown {
  return {
    async run(
      _input: string,
      onChunk?: (c: string) => void,
      onMeta?: (m: string, kind?: MetaKind, info?: RetractInfo) => void,
    ): Promise<AgentResult> {
      onMeta?.("ctx 8k / 32k", "status");
      onMeta?.("thought report pulled", "retract", {
        source: "hallucination",
        reason: "claim without evidence",
        iteration: 1,
      });
      onMeta?.("critic: success", "critic", {
        source: "critic",
        critic: report as never,
        verdict: "success",
      });
      onChunk?.("final answer");
      return { success: true, text: "final answer", iterationCount: 1 };
    },
    setPromptIO() {},
    shutdown() {},
    pause() {},
    resume() {},
  };
}

async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  dir = tempServiceDir();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  cleanupServiceDir(dir);
});

describe("meta events over the host wire (W9)", () => {
  it("delivers meta, retract and critic to a thin client", async () => {
    const report = {
      status: "success",
      durationMs: 5,
      passes: 1,
      issues: [],
      checks: [{ tool: "read_file", ok: true }],
      summary: "all good",
    };
    const svc = startAgentService(makeServiceDeps({ dir, agent: metaAgent(report) }));
    stop = svc.stop;
    const base = await svc.url;
    const sessionId = await firstSessionId(base);

    const host = new RemoteHost({ baseUrl: base, sessionId });
    const events: HostEvent[] = [];
    host.subscribeEvents((ev) => events.push(ev));

    await host.submit("check it");
    await waitFor(() => events.some((e) => e.type === "task.finished"));

    const meta = events.find((e) => e.type === "meta");
    expect(meta?.data).toMatchObject({ chunk: "ctx 8k / 32k", kind: "status" });

    const retract = events.find((e) => e.type === "retract");
    expect(retract?.data).toMatchObject({
      label: "thought report pulled",
      reason: "claim without evidence",
      source: "hallucination",
      iteration: 1,
    });

    const critic = events.find((e) => e.type === "critic");
    expect(critic).toBeDefined();
    expect(critic?.data).toMatchObject({
      label: "critic: success",
      status: "success",
      passes: 1,
      summary: "all good",
      verdict: "success",
    });
    const criticData = critic?.data as { checks?: unknown[] } | undefined;
    expect(criticData?.checks).toHaveLength(1);

    host.dispose();
  });

  it("maps meta/retract/critic into web SSE events", async () => {
    const { mapHostEvent } = await import("../../src/modules/webui/daemon-events");
    const base = { type: "x", ts: 1, sessionId: "S" };

    expect(
      mapHostEvent({ ...base, type: "meta", data: { chunk: "hi", kind: "tool" } }),
    ).toMatchObject({ type: "meta", chunk: "hi", kind: "tool" });

    expect(
      mapHostEvent({
        ...base,
        type: "retract",
        data: { label: "l", reason: "r", source: "critic" },
      }),
    ).toMatchObject({ type: "retract", label: "l", reason: "r", source: "critic" });

    expect(
      mapHostEvent({
        ...base,
        type: "critic",
        data: { status: "success", durationMs: 3, passes: 1, issues: [], checks: [] },
      }),
    ).toMatchObject({ type: "critic", status: "success", passes: 1 });
  });
});
