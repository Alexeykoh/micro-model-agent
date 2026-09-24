import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { handleRequest } from "../src/modules/webui/server";
import { createWebUiState } from "../src/modules/webui/state";
import { buildHostState, captureUsage, type HostStateInput } from "../src/modules/webui/module";
import { DEFAULTS } from "../src/config/defaults";
import type { AgentResult } from "../src/core/types";
import type { Host, HostStateSnapshot } from "../src/core/host";

const assets = { html: "<h1>hi</h1>", css: "body{}", js: "//ok" };

const doFetch: typeof fetch =
  typeof Bun !== "undefined" ? (Bun as unknown as { fetch: typeof fetch }).fetch.bind(Bun) : fetch;

async function withServer(
  bridge: Host,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const s = createWebUiState();
  s.bridge = bridge;
  const srv = createServer((req, res) => handleRequest(req, res, assets, s));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    srv.close();
  }
}

function fakeHost(input: HostStateInput): Host {
  return {
    isBusy: () => false,
    submit: async () => undefined,
    interrupt: () => {},
    subscribeOutput: () => () => {},
    executeCommand: async () => {},
    getState: () => buildHostState(input, false),
  };
}

describe("webui usage metrics", () => {
  it("captureUsage maps AgentResult fields and applies the limit fallback", () => {
    const result: AgentResult = {
      success: true,
      text: "",
      iterationCount: 3,
      contextUsed: 4321,
      totalCost: 0.0123,
      compactionCount: 2,
      contextQuality: 91,
      cache: {
        cachedTokens: 100,
        uncachedTokens: 100,
        cacheWriteTokens: 0,
        hitRate: 0.5,
        saved: 0.004,
        source: "api",
      },
    };
    const usage = captureUsage(result, 32768);
    expect(usage).toEqual({
      contextUsed: 4321,
      contextLimit: 32768,
      costUsd: 0.0123,
      compactionCount: 2,
      cacheHitRate: 0.5,
      cacheSaved: 0.004,
      contextQuality: 91,
    });
  });

  it("captureUsage omits unknown fields instead of blanking them", () => {
    const usage = captureUsage({ success: true, text: "", iterationCount: 1 }, undefined);
    expect(usage).toEqual({});
  });

  it("buildHostState surfaces captured usage in the snapshot", () => {
    const config = structuredClone(DEFAULTS);
    const snapshot: HostStateSnapshot = buildHostState(
      {
        config,
        usage: {
          contextUsed: 1000,
          contextLimit: 65536,
          costUsd: 0.5,
          compactionCount: 1,
          cacheHitRate: 0.25,
          contextQuality: 80,
        },
      },
      false,
    );
    expect(snapshot.contextUsed).toBe(1000);
    expect(snapshot.contextLimit).toBe(65536);
    expect(snapshot.costUsd).toBe(0.5);
    expect(snapshot.compactionCount).toBe(1);
    expect(snapshot.cacheHitRate).toBe(0.25);
    expect(snapshot.contextQuality).toBe(80);
  });

  it("GET /api/state reflects usage after a turn", async () => {
    const config = structuredClone(DEFAULTS);
    const bridge = fakeHost({
      config,
      usage: { contextUsed: 2048, contextLimit: 32768, cacheHitRate: 0.75, costUsd: 0.02 },
    });
    await withServer(bridge, async (base) => {
      const res = await doFetch(base + "/api/state");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        busy: boolean;
        state: HostStateSnapshot;
      };
      expect(body.state.contextUsed).toBe(2048);
      expect(body.state.contextLimit).toBe(32768);
      expect(body.state.cacheHitRate).toBe(0.75);
      expect(body.state.costUsd).toBe(0.02);
    });
  });

  it("buildHostState surfaces the environment (workspace, AGENTS.md, map)", () => {
    const config = structuredClone(DEFAULTS);
    const snapshot = buildHostState(
      {
        config,
        workspace: "E:/proj",
        instructions: { files: ["E:/proj/AGENTS.md"], disabled: false },
        projectMap: { indexed: true, files: 12, symbols: 34, tokens: 567 },
      },
      false,
    );
    expect(snapshot.workspace).toBe("E:/proj");
    expect(snapshot.instructions).toEqual({ files: ["E:/proj/AGENTS.md"], disabled: false });
    expect(snapshot.projectMap).toEqual({ indexed: true, files: 12, symbols: 34, tokens: 567 });
  });

  it("GET /api/state includes the environment block", async () => {
    const config = structuredClone(DEFAULTS);
    const bridge = fakeHost({
      config,
      workspace: "E:/proj",
      instructions: { files: [], disabled: true },
      projectMap: { indexed: false, files: 0, symbols: 0, tokens: 0 },
    });
    await withServer(bridge, async (base) => {
      const res = await doFetch(base + "/api/state");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { state: HostStateSnapshot };
      expect(body.state.workspace).toBe("E:/proj");
      expect(body.state.instructions?.disabled).toBe(true);
      expect(body.state.projectMap?.indexed).toBe(false);
    });
  });
});
