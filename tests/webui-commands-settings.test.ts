import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { t } from "../src/i18n";
import type { SessionMessage } from "../src/modules/session/types";
import { fakeSessions, makeHarness, meta } from "./helpers/webui-commands";

describe("webui settings slash commands", () => {
  it("/reasoning reports status without args", async () => {
    const h = makeHarness();
    await h.run("/reasoning");
    expect(h.lines[0]).toContain("reasoning:");
    expect(h.lines[0]).toContain("level auto");
  });

  it("/reasoning hide writes showReasoning", async () => {
    const h = makeHarness();
    await h.run("/reasoning hide");
    expect(h.config.showReasoning).toBe(false);
    expect(h.saved).toHaveLength(1);
    expect(h.lines).toEqual(["showReasoning = off · saved"]);
  });

  it("/reasoning level writes reasoning.mode and reconfigures", async () => {
    const h = makeHarness();
    await h.run("/reasoning level high");
    expect(h.config.reasoning?.mode).toBe("high");
    expect(h.reconfigures()).toBe(1);
    expect(h.lines).toEqual(["reasoning.mode = high · saved"]);
  });

  it("/verbose writes ui.verbosity", async () => {
    const h = makeHarness();
    await h.run("/verbose verbose");
    expect(h.config.ui.verbosity).toBe("verbose");
    expect(h.saved).toHaveLength(1);
    expect(h.lines).toEqual(["ui.verbosity = verbose · saved"]);
  });

  it("/verbose without args reports the current level", async () => {
    const h = makeHarness();
    await h.run("/verbose");
    expect(h.lines[0]).toContain("verbosity:");
  });

  it("/context reports usage from the state snapshot", async () => {
    const h = makeHarness();
    h.state.usage = { contextUsed: 1000, contextLimit: 32768 };
    await h.run("/context");
    expect(h.lines).toEqual(["context: 1000 / 32768 tok"]);
  });

  it("/context <N> sets contextWindow and reconfigures", async () => {
    const h = makeHarness();
    await h.run("/context 65536");
    expect(h.config.contextWindow).toBe(65536);
    expect(h.reconfigures()).toBe(1);
    expect(h.lines).toEqual(["contextWindow = 65536 · saved"]);
  });

  it("/session list marks the active session", async () => {
    const h = makeHarness();
    await h.run("/session list");
    expect(h.lines).toEqual(["* ses_1  work  (3 msgs)"]);
  });

  it("/session use activates a matching session", async () => {
    const h = makeHarness();
    h.state.sessionManager = fakeSessions(
      [meta("ses_1", "work", true), meta("ses_2", "play", false)],
      "ses_1",
    );
    await h.run("/session use ses_2");
    expect(h.state.sessionManager.getActive()).toBe("ses_2");
    expect(h.lines[0]).toContain("active session: play");
  });

  it("/session use reports an unknown id without throwing", async () => {
    const h = makeHarness();
    await h.run("/session use nope");
    expect(h.lines).toEqual(["↳ no matching session: nope"]);
  });

  it("/export is unsupported when the store exposes no history", async () => {
    const h = makeHarness();
    await h.run("/export");
    expect(h.lines[0]).toContain("export unavailable");
  });

  it("/export writes a file when history is available", async () => {
    const h = makeHarness();
    const dir = mkdtempSync(join(tmpdir(), "webui-export-"));
    try {
      const base = fakeSessions([meta("ses_1", "work", true)], "ses_1");
      const history: SessionMessage[] = [
        { role: "user", content: "hi", timestamp: "2026-01-01T00:00:00.000Z" },
      ];
      base.getHistory = () => history;
      base.loadSessionLog = () => [];
      h.state.sessionManager = base;
      const target = join(dir, "out.md");
      await h.run(`/export md --out ${target}`);
      expect(existsSync(target)).toBe(true);
      expect(h.lines[0]).toContain("exported md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("web /security status prints toggles", async () => {
    const h = makeHarness();
    await h.run("/security status");
    expect(h.lines).toHaveLength(3);
    expect(h.lines[0]).toMatch(/security/);
    expect(h.lines[1]).toMatch(/bash/);
    expect(h.lines[1]).toMatch(/network/);
    expect(h.lines[2]).toMatch(/contentScan/);
  });

  it("web /security bogusarg reports a localized unknown-subcommand hint", async () => {
    const h = makeHarness();
    await h.run("/security bogusarg");
    expect(h.lines).toHaveLength(2);
    expect(h.lines[0]).toBe(`↳ ${t("web.security.unknown_sub", { sub: "bogusarg" })}`);
    expect(h.lines[1]).toContain("usage:");
    expect(h.lines[1]).toContain("/security");
  });
});
