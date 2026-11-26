import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentsMdBlocks } from "../../src/core/bootstrap/instructions";
import {
  forgetRemoteInstruction,
  preloadRemoteInstructions,
} from "../../src/core/bootstrap/remote-instructions";

const URL_PUBLIC = "https://example.com/agents.md";
const URL_PRIVATE = "https://127.0.0.1/agents.md";
const resolver = async () => [{ address: "1.1.1.1" }];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-remote-instr-"));
  forgetRemoteInstruction(URL_PUBLIC);
  forgetRemoteInstruction(URL_PRIVATE);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("HTTPS-источники инструкций", () => {
  it("грузить по HTTPS и отдавать блок в загрузчике", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Remote instructions", { status: 200 }),
    );

    const result = await preloadRemoteInstructions([URL_PUBLIC], undefined, resolver);
    expect(result.loaded).toEqual([URL_PUBLIC]);

    const blocks = loadAgentsMdBlocks(dir, dir, false, [URL_PUBLIC]);
    const remote = blocks.find((b) => b.content === "Remote instructions");
    expect(remote).toBeDefined();
    expect(remote?.kind).toBe("instructions");
  });

  it("приватный адрес отклоняется без сетевого вызова", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await preloadRemoteInstructions([URL_PRIVATE], undefined, resolver);
    expect(result.blocked).toContain(URL_PRIVATE);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loadAgentsMdBlocks(dir, dir, false, [URL_PRIVATE])).toEqual([]);
  });

  it("таймаут/ошибка fetch не роняют загрузчик", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const result = await preloadRemoteInstructions([URL_PUBLIC], undefined, resolver);
    expect(result.blocked).toContain(URL_PUBLIC);
    expect(loadAgentsMdBlocks(dir, dir, false, [URL_PUBLIC])).toEqual([]);
  });
});
