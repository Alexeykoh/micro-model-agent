import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/modules/memory/store";
import { handleRequest } from "../src/modules/webui/server";
import { createWebUiState, type WebUiState } from "../src/modules/webui/state";
import { webCommandList } from "../src/modules/webui/commands";
import { makeHarness } from "./helpers/webui-commands";

describe("webui slash commands", () => {
  it("/help lists the supported subset", async () => {
    const h = makeHarness();
    await h.run("/help");
    const joined = h.lines.join("\n");
    expect(joined).toContain("/config <key> [value]");
    expect(joined).toContain("/model list");
    expect(joined).toContain("/memory");
    expect(joined).toContain("/status");
    expect(joined).toContain("/reasoning");
    expect(joined).toContain("/verbose");
    expect(joined).toContain("/context");
    expect(joined).toContain("/session list");
    expect(joined).toContain("/export");
  });

  it("/status reports model, provider, context, session and verbosity", async () => {
    const h = makeHarness();
    await h.run("/status");
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain("original-model");
    expect(h.lines[0]).toContain("32768 tok");
    expect(h.lines[0]).toContain("work (3 msgs)");
    expect(h.lines[0]).toContain(" · ");
  });

  it("/config <key> reads through the registry", async () => {
    const h = makeHarness();
    await h.run("/config model");
    expect(h.lines).toEqual(["model = original-model"]);
  });

  it("/config <key> <value> writes, persists and reconfigures", async () => {
    const h = makeHarness();
    await h.run("/config contextWindow 65536");
    expect(h.config.contextWindow).toBe(65536);
    expect(h.saved).toHaveLength(1);
    expect(h.reconfigures()).toBe(1);
    expect(h.lines).toEqual(["contextWindow = 65536 · saved"]);
  });

  it("/config accepts aliases", async () => {
    const h = makeHarness();
    await h.run("/config context.window 16384");
    expect(h.config.contextWindow).toBe(16384);
    expect(h.lines).toEqual(["contextWindow = 16384 · saved"]);
  });

  it("/config rejects an unknown key without throwing", async () => {
    const h = makeHarness();
    await h.run("/config not.a.key 1");
    expect(h.lines[0]).toContain("unknown key: not.a.key");
    expect(h.saved).toHaveLength(0);
  });

  it("/model use switches the model and reconfigures", async () => {
    const h = makeHarness();
    await h.run("/model use m2");
    expect(h.config.model).toBe("m2");
    expect(h.reconfigures()).toBe(1);
    expect(h.lines).toEqual(["model = m2 · saved"]);
  });

  it("/model list marks the current model", async () => {
    const h = makeHarness();
    h.state.knownModels = () => ["original-model", "m2"];
    await h.run("/model list");
    expect(h.lines).toContain("current: original-model");
    expect(h.lines).toContain("* original-model");
    expect(h.lines).toContain("  m2");
  });

  it("/provider use switches the active provider", async () => {
    const h = makeHarness();
    h.config.provider.entries = [
      { type: "openai-compat", label: "local" },
      { type: "openrouter", label: "remote" },
    ];
    h.config.provider.active = "local";
    await h.run("/provider use remote");
    expect(h.config.provider.active).toBe("remote");
    expect(h.reconfigures()).toBe(1);
    expect(h.lines).toEqual(["provider.active = remote · saved"]);
  });

  it("/provider list marks the active entry", async () => {
    const h = makeHarness();
    h.config.provider.entries = [
      { type: "openai-compat", label: "local" },
      { type: "openrouter", label: "remote" },
    ];
    h.config.provider.active = "remote";
    await h.run("/provider list");
    expect(h.lines).toContain("* remote (openrouter)");
    expect(h.lines).toContain("  local (openai-compat)");
  });

  it("unknown command emits a dim hint and never throws", async () => {
    const h = makeHarness();
    await h.run("/nope");
    expect(h.lines).toEqual(["↳ unknown command: nope"]);
  });

  it("non-slash input is ignored", async () => {
    const h = makeHarness();
    await h.run("hello world");
    await h.run("");
    expect(h.lines).toHaveLength(0);
  });

  it("redacts credential-shaped output", async () => {
    const h = makeHarness();
    const secret = "sk-abcdefghijklmnopqrstuvwx";
    await h.run(`/config model ${secret}`);
    expect(h.lines.join("\n")).not.toContain(secret);
    expect(h.lines.join("\n")).toContain("sk-[REDACTED]");
  });

  it("/memory reports unavailable without a store", async () => {
    const h = makeHarness();
    await h.run("/memory");
    expect(h.lines).toEqual(["↳ memory unavailable"]);
  });

  it("/memory set/get/overview operate on the shared store", async () => {
    const h = makeHarness();
    const dir = mkdtempSync(join(tmpdir(), "webui-mem-"));
    try {
      h.state.memory = new MemoryStore(dir);
      await h.run("/memory set name Alice");
      expect(h.lines).toEqual(["saved name=Alice"]);
      h.lines.length = 0;
      await h.run("/memory get name");
      expect(h.lines).toEqual(["name = Alice"]);
      h.lines.length = 0;
      await h.run("/memory");
      expect(h.lines.join("\n")).toContain("name = Alice");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const assets = { html: "<h1>hi</h1>", css: "body{}", js: "//ok" };
const doFetch: typeof fetch =
  typeof Bun !== "undefined" ? (Bun as unknown as { fetch: typeof fetch }).fetch.bind(Bun) : fetch;

async function withServer(s: WebUiState, fn: (base: string) => Promise<void>): Promise<void> {
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

describe("webui commands api", () => {
  it("webCommandList exposes name/usage/desc for every supported command", () => {
    const list = webCommandList();
    expect(list.length).toBeGreaterThan(5);
    const names = list.map((c) => c.name);
    expect(names).toContain("help");
    expect(names).toContain("model");
    expect(names).toContain("config");
    for (const c of list) {
      expect(c.usage.startsWith("/")).toBe(true);
      expect(c.name).toBe(c.usage.slice(1).split(/[\s|]/)[0]);
      expect(typeof c.desc).toBe("string");
    }
  });

  it("GET /api/commands returns the list (autocomplete source)", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/commands`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { commands: Array<{ name: string }> };
      expect(Array.isArray(body.commands)).toBe(true);
      expect(body.commands.map((c) => c.name)).toContain("help");
    });
  });
});
