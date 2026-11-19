import { describe, expect, it } from "vitest";
import { createWebUiState } from "../src/modules/webui/state";
import { makeWebCommands } from "../src/modules/webui/chat/commands";

// `/reload` в вебе: мягкий re-read источников без перезапуска процесса.
// Колбэк `state.reload` вяжет CLI; здесь проверяем диспетчер и отчёт.

describe("webui: /reload", () => {
  it("reports the reloaded instruction files and blocks", async () => {
    const state = createWebUiState();
    const lines: string[] = [];
    state.reload = async () => ({ files: ["AGENTS.md"], instructions: 2 });
    const dispatch = makeWebCommands({ state, emit: (text) => lines.push(text) });

    await dispatch("/reload");

    const text = lines.join("\n");
    expect(text).not.toContain("↳");
    expect(text).toContain("2");
  });

  it("fails honestly when the surface has no reload hook", async () => {
    const state = createWebUiState();
    const lines: string[] = [];
    const dispatch = makeWebCommands({ state, emit: (text) => lines.push(text) });

    await dispatch("/reload");

    expect(lines.join("\n")).toContain("reload unavailable");
  });

  it("is listed in /help", async () => {
    const state = createWebUiState();
    const lines: string[] = [];
    const dispatch = makeWebCommands({ state, emit: (text) => lines.push(text) });

    await dispatch("/help");

    expect(lines.join("\n")).toContain("/reload");
  });
});
