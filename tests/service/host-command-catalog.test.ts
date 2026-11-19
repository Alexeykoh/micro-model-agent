/**
 * W12: полный каталог команд на проводе. `mma serve` исполняет тот же набор,
 * что терминал (кроме интерактивных), thin-REPL и web-адаптер получают каталог
 * `/v1/host/commands`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../../src/core/types";
import { startAgentService } from "../../src/modules/service/module";
import type { AgentServiceState } from "../../src/modules/service/state";
import { httpJson } from "./http-client";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./harness";

let dir: string;
let stop: (() => void) | undefined;
let base: string;
let state: AgentServiceState;
let sessionId: string;

function idleAgent() {
  return {
    async run(): Promise<AgentResult> {
      return { success: true, text: "ok", iterationCount: 1 };
    },
    setPromptIO() {},
    shutdown() {},
    pause() {},
    resume() {},
  };
}

beforeEach(async () => {
  dir = tempServiceDir();
  const svc = startAgentService(makeServiceDeps({ dir, agent: idleAgent() }));
  stop = svc.stop;
  state = svc.state;
  base = await svc.url;
  sessionId = await firstSessionId(base);
});

afterEach(() => {
  stop?.();
  stop = undefined;
  cleanupServiceDir(dir);
});

async function run(line: string) {
  const res = await httpJson(`${base}/v1/host/sessions/${sessionId}/command`, {
    method: "POST",
    json: { line },
  });
  return res.json as { ok: boolean; output: string[]; error?: string };
}

describe("host command catalog (W12)", () => {
  it("publishes every catalog command with wire availability", async () => {
    const res = await httpJson(`${base}/v1/host/commands`);
    expect(res.status).toBe(200);
    const commands = res.json.commands as Array<{
      name: string;
      description: string;
      available: boolean;
      reason?: string;
    }>;
    expect(commands.length).toBeGreaterThanOrEqual(30);
    for (const name of ["help", "config", "model", "sessions", "memory", "plugins", "lsp", "run", "diagnostics"]) {
      expect(commands.some((c) => c.name === name && c.available)).toBe(true);
    }
    for (const name of ["wizard", "meet", "image", "doctor"]) {
      expect(commands.some((c) => c.name === name && !c.available && c.reason === "terminal-only")).toBe(
        true,
      );
    }
  });

  it("answers help, status, model/provider/context/reasoning/verbose/security", async () => {
    expect((await run("/help")).output.join("\n")).toContain("/config");
    expect((await run("/status")).output.join("\n")).toContain("tok");
    expect((await run("/model list")).ok).toBe(true);
    expect((await run("/provider list")).ok).toBe(true);
    expect((await run("/context")).ok).toBe(true);
    expect((await run("/reasoning")).output.join("\n")).toContain("reasoning:");
    expect((await run("/verbose")).ok).toBe(true);
    expect((await run("/security status")).output.join("\n")).toContain("security");
  });

  it("reads and writes config through the shared writer", async () => {
    const read = await run("/config get model");
    expect(read.ok).toBe(true);
    expect(read.output[0]).toContain("model=");

    let saved = false;
    state.deps.saveConfig = () => {
      saved = true;
    };
    const write = await run("/config set ui.themeMode dark");
    expect(write.ok).toBe(true);
    expect(state.config.ui.themeMode).toBe("dark");
    expect(saved).toBe(true);

    const reset = await run("/config reset ui.themeMode");
    expect(reset.ok).toBe(true);
    expect(state.config.ui.themeMode).toBe("auto");

    const unknown = await run("/config get nope.nope");
    expect(unknown.ok).toBe(false);
  });

  it("manages sessions from the wire", async () => {
    const created = await run("/sessions new wire");
    expect(created.ok).toBe(true);
    const id = created.output[0].split("\t")[0];
    expect(state.deps.sessionManager?.get(id)?.name).toBe("wire");

    expect((await run(`/sessions use ${id}`)).ok).toBe(true);
    expect((await run("/rename renamed")).ok).toBe(true);
    expect(state.deps.sessionManager?.get(id)?.name).toBe("renamed");
    expect((await run(`/delete ${id}`)).ok).toBe(true);
    expect(state.deps.sessionManager?.get(id)).toBeNull();
  });

  it("manages memory, plugins, skills and LSP", async () => {
    const entries: string[] = [];
    state.deps.memory = {
      getPreferences: () => ({ tone: "brief" }),
      read: () => entries.map((text) => `- ${text}`).join("\n"),
      append: (_c: string, text: string) => entries.push(text),
      deleteEntry: (_c: string, n: number) => {
        if (!entries[n - 1]) return false;
        entries.splice(n - 1, 1);
        return true;
      },
    } as never;

    expect((await run("/memory add facts hello world")).ok).toBe(true);
    expect((await run("/memory find hello")).output.join("\n")).toContain("hello");
    expect((await run("/memory forget facts 1")).ok).toBe(true);
    expect(entries).toEqual([]);

    const enabled: Array<[string, boolean]> = [];
    state.deps.plugins = {
      getRecords: () => [{ name: "p1", system: false }],
      getFailures: () => [],
      getPlugin: () => null,
      setEnabled: (name: string, on: boolean) => {
        enabled.push([name, on]);
        return true;
      },
      isEnabled: () => false,
      reload: () => ({ loaded: 1, staleTs: 0 }),
    } as never;
    expect((await run("/plugins")).output.join("\n")).toContain("p1");
    expect((await run("/plugins p1 on")).ok).toBe(true);
    expect(enabled).toEqual([["p1", true]]);
    expect((await run("/reload")).ok).toBe(true);

    state.deps.reloadSources = async () => ({ files: ["AGENTS.md"], instructions: [] });
    state.deps.reconfigure = async () => {};
    const soft = await run("/reload");
    expect(soft.ok).toBe(true);
    expect(soft.output.join("\n")).toContain("AGENTS.md");

    state.deps.skills = {
      getLoaded: () => [{ name: "alpha" }],
      getAvailable: () => [{ name: "alpha" }, { name: "beta" }],
      reloadSources: () => ({ added: 0, removed: 0 }),
    } as never;
    expect((await run("/skill")).output.join("\n")).toContain("alpha");

    state.deps.lsp = {
      getFlags: () => ({ enabled: true, offline: false }),
      diagnose: async () => ({ ok: true, servers: [] }),
    } as never;
    expect((await run("/lsp")).output.join("\n")).toContain("enabled: true");
    expect((await run("/lsp doctor")).ok).toBe(true);
  });

  it("refuses terminal-only and unknown commands honestly", async () => {
    const wizard = await run("/wizard");
    expect(wizard.ok).toBe(false);
    expect(String(wizard.error)).toContain("terminal");

    const unknown = await run("/definitely-not-a-command");
    expect(unknown.ok).toBe(false);
    expect(String(unknown.error)).toContain("unknown");
  });

  it("runs a turn via /run and reports daemon diagnostics (W13)", async () => {
    const runRes = await run("/run hello world");
    expect(runRes.ok).toBe(true);
    expect(runRes.output.join(" ")).toContain("turn started");

    const diag = await run("/diagnostics");
    expect(diag.ok).toBe(true);
    const text = diag.output.join("\n");
    expect(text).toContain("version:");
    expect(text).toContain("workspace:");
    expect(text).toContain("sessions:");
    expect(text).toContain("plugins:");
  });
});
