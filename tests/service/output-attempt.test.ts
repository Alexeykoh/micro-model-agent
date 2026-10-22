/**
 * W10.5: первая попытка structured output не попадает в SSE; события retry
 * помечены `attempt:2`.
 */
import { get } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../../src/core/types";
import { startAgentService } from "../../src/modules/service/module";
import { httpJson } from "./http-client";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./harness";

let dir: string;
let stop: (() => void) | undefined;

beforeEach(() => {
  dir = tempServiceDir();
});
afterEach(() => {
  stop?.();
  stop = undefined;
  cleanupServiceDir(dir);
});

/** Первая попытка — невалидный JSON и текст BAD, вторая — валидный и GOOD. */
function retryAgent(): unknown {
  let calls = 0;
  return {
    async run(_input: string, onChunk?: (c: string) => void): Promise<AgentResult> {
      calls++;
      if (calls === 1) {
        onChunk?.("BAD");
        return { success: true, text: '{"wrong":true}', iterationCount: 1 };
      }
      onChunk?.("GOOD");
      return { success: true, text: '{"title":"ok"}', iterationCount: 1 };
    },
    setPromptIO() {},
    shutdown() {},
  };
}

function openSse(url: string): { text: () => string; close: () => void } {
  let buf = "";
  const request = get(url, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buf += chunk;
    });
  });
  return { text: () => buf, close: () => request.destroy() };
}

async function waitFor(pred: () => boolean, label: string, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("structured output attempts", () => {
  it("hides the failed first attempt and tags the retry", async () => {
    const svc = startAgentService(makeServiceDeps({ dir, agent: retryAgent() }));
    stop = svc.stop;
    const url = await svc.url;
    const sid = await firstSessionId(url);
    const sse = openSse(`${url}/v1/sessions/${sid}/events`);
    try {
      const res = await httpJson(`${url}/v1/sessions/${sid}/tasks`, {
        method: "POST",
        json: {
          input: "x",
          mode: "job",
          wait: true,
          output: {
            format: "json",
            schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
          },
        },
      });
      expect(res.json.status).toBe("succeeded");
      await waitFor(() => sse.text().includes("GOOD"), "retry text");
      expect(sse.text()).not.toContain("BAD");
      expect(sse.text()).toContain('"attempt":2');
    } finally {
      sse.close();
    }
  });
});
