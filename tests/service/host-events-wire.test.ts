/**
 * W10b: словарь событий host wire — `log` (шина вывода) и картинки тулов.
 * Локальный веб их видит; thin-клиент раньше терял и то, и другое.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult, ToolEvent } from "../../src/core/types";
import { startAgentService } from "../../src/modules/service/module";
import { RemoteHost } from "../../src/modules/daemon/remote-host";
import { defaultOutputBus } from "../../src/output";
import type { HostEvent } from "../../src/core/host";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./harness";

let dir: string;
let stop: (() => void) | undefined;

function imageAgent() {
  return {
    async run(
      _input: string,
      _onChunk?: (c: string) => void,
      _onMeta?: unknown,
      onTool?: (ev: ToolEvent) => void,
    ): Promise<AgentResult> {
      onTool?.({ type: "start", tool: "screenshot", args: {} });
      onTool?.({
        type: "end",
        tool: "screenshot",
        args: {},
        output: "took a shot",
        duration: 4,
        images: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }],
        imageRefs: [{ file: "shot-1.png", bytes: 128, at: "2026-11-14T00:00:00Z" }],
      } as ToolEvent);
      return { success: true, text: "done", iterationCount: 1 };
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

describe("host wire event dictionary (W10b)", () => {
  it("forwards tool images (inline + saved refs) in tool.end", async () => {
    const svc = startAgentService(makeServiceDeps({ dir, agent: imageAgent() }));
    stop = svc.stop;
    const base = await svc.url;
    const sessionId = await firstSessionId(base);
    const host = new RemoteHost({ baseUrl: base, sessionId });
    const events: HostEvent[] = [];
    host.subscribeEvents((ev) => events.push(ev));

    await host.submit("shot");
    await waitFor(() => events.some((e) => e.type === "task.finished"));

    const end = events.find((e) => e.type === "tool.end");
    expect(end?.data).toMatchObject({
      name: "screenshot",
      images: ["data:image/png;base64,AA=="],
      imageRefs: ["shot-1.png"],
    });
    host.dispose();
  });

  it("forwards OutputBus warnings scoped to their session as `log`", async () => {
    const svc = startAgentService(makeServiceDeps({ dir, agent: imageAgent() }));
    stop = svc.stop;
    const base = await svc.url;
    const sessionId = await firstSessionId(base);
    const host = new RemoteHost({ baseUrl: base, sessionId });
    const events: HostEvent[] = [];
    host.subscribeEvents((ev) => events.push(ev));

    defaultOutputBus.emit({
      level: "warn",
      source: "core",
      kind: "log",
      text: "context probe timed out",
      sessionId,
    });
    await waitFor(() => events.some((e) => e.type === "log"));

    const log = events.find((e) => e.type === "log");
    expect(log?.data).toMatchObject({
      level: "warn",
      source: "core",
      text: "context probe timed out",
      diagnostic: false,
    });

    // Событие без владельца не уходит в чужую сессию.
    const before = events.length;
    defaultOutputBus.emit({
      level: "warn",
      source: "core",
      kind: "log",
      text: "global warning",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(events.length).toBe(before);
    host.dispose();
  });
});
