import { describe, it, expect } from "vitest";
import type { ServerResponse } from "node:http";
import {
  buildHostState,
  captureUsage,
  makeReconfigure,
  type HostStateInput,
} from "../src/modules/webui/module";
import { DEFAULTS } from "../src/config/defaults";
import type { AgentResult } from "../src/core/types";
import type { Host, HostStateSnapshot } from "../src/core/host";
import { createWebUiState } from "../src/modules/webui/state";
import { doFetch, withServer } from "./helpers/webui-server";




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

  it("buildHostState surfaces the effective contextWindow for late auto-detect", () => {
    const config = structuredClone(DEFAULTS);
    config.contextWindow = 1000000;
    const snapshot: HostStateSnapshot = buildHostState({ config }, false);
    expect(snapshot.contextWindow).toBe(1000000);
  });

  it("makeReconfigure refreshes the sidebar context limit after a resize", async () => {
    const s = createWebUiState();
    s.usage = { contextUsed: 1000, contextLimit: 24576, costUsd: 0.1 };
    const writes: string[] = [];
    s.clients.add({
      write: (payload: string) => {
        writes.push(payload);
        return true;
      },
    } as unknown as ServerResponse);

    let history = 24576;
    const agent = {
      reconfigure: () => {
        history = 86016;
      },
      contextManager: { getBudget: () => ({ history }) },
    };
    await makeReconfigure(s, agent)(structuredClone(DEFAULTS));

    expect(s.usage?.contextLimit).toBe(86016);
    expect(s.usage?.contextUsed).toBe(1000);
    expect(s.usage?.costUsd).toBe(0.1);
    expect(writes.join("")).toContain('"contextLimit":86016');
  });

  it("makeReconfigure seeds a limit even before the first turn", async () => {
    const s = createWebUiState();
    const agent = {
      reconfigure: () => {},
      contextManager: { getBudget: () => ({ history: 49152 }) },
    };
    await makeReconfigure(s, agent)(structuredClone(DEFAULTS));
    expect(s.usage).toEqual({ contextLimit: 49152 });
  });

  it("GET /api/state reflects usage after a turn", async () => {
    const config = structuredClone(DEFAULTS);
    const bridge = fakeHost({
      config,
      usage: { contextUsed: 2048, contextLimit: 32768, cacheHitRate: 0.75, costUsd: 0.02 },
    });
    const s = createWebUiState();
    s.bridge = bridge;
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/state`);
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
    const s = createWebUiState();
    s.bridge = bridge;
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/state`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { state: HostStateSnapshot };
      expect(body.state.workspace).toBe("E:/proj");
      expect(body.state.instructions?.disabled).toBe(true);
      expect(body.state.projectMap?.indexed).toBe(false);
    });
  });

  it("passes a full ProjectMapInfo through to the snapshot", () => {
    const snapshot = buildHostState(
      {
        config: structuredClone(DEFAULTS),
        projectMap: {
          indexed: true,
          indexing: false,
          files: 3,
          symbols: 9,
          tokens: 100,
          updatedAt: 1700000000000,
          languages: [{ language: "typescript", files: 2, symbols: 8 }],
          watcher: true,
        },
      },
      false,
    );
    expect(snapshot.projectMap).toMatchObject({ updatedAt: 1700000000000, watcher: true });
  });
});
