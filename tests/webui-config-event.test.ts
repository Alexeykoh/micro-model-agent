// Regression guard: a slash command that changes config must broadcast a
// `config` SSE event so every open client re-reads `/api/config` and the
// Settings panel does not show a stale value (bug: `/verbose verbose` saved
// but the panel kept `quiet` until a page reload).
import { describe, it, expect } from "vitest";
import type { ServerResponse } from "node:http";
import { createWebUiState } from "../src/modules/webui/state";
import { makeWebCommands } from "../src/modules/webui/chat/commands";
import { DEFAULTS } from "../src/config/defaults";

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

describe("config change SSE event", () => {
  it("broadcasts `config` after a slash-command config write", async () => {
    const s = createWebUiState();
    s.config = JSON.parse(JSON.stringify(DEFAULTS));
    s.saveConfig = () => {};
    const chunks: string[] = [];
    s.clients.add(fakeClient(chunks));

    const dispatch = makeWebCommands({ state: s });
    await dispatch("/verbose verbose");

    expect(s.config.ui.verbosity).toBe("verbose");
    expect(chunks.join("")).toContain("event: config");
  });
});
