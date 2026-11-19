import { describe, it, expect } from "vitest";
import {
  NotifyPlugin,
  notificationCommand,
} from "../../../../src/modules/plugins/builtin/notify";
import type { TurnSummary } from "../../../../src/modules/types";
import type { ToolContext } from "../../../../src/tools/types";

const summary = (over: Partial<TurnSummary> = {}): TurnSummary => ({
  success: true,
  durationMs: 1234,
  textLength: 10,
  toolCalls: 2,
  ...over,
});

function ctx(): ToolContext & { debug: string[] } {
  const debug: string[] = [];
  return {
    logger: { debug: (msg: string) => debug.push(msg) },
    debug,
  } as unknown as ToolContext & { debug: string[] };
}

describe("NotifyPlugin", () => {
  it("sends one desktop notification per successful turn", () => {
    const calls: Array<{ title: string; body: string }> = [];
    const plugin = new NotifyPlugin((title, body) => calls.push({ title, body }));
    const c = ctx();
    plugin.onTurnEnd!(c, summary());
    expect(calls.length).toBe(1);
    expect(calls[0].title).toBe("MMA");
    expect(calls[0].body).toContain("Done");
    expect(calls[0].body).toContain("1.2s");
    expect(calls[0].body).toContain("2");
  });

  it("marks failed and interrupted turns", () => {
    const bodies: string[] = [];
    const plugin = new NotifyPlugin((_t, body) => bodies.push(body));
    plugin.onTurnEnd!(ctx(), summary({ success: false }));
    plugin.onTurnEnd!(ctx(), summary({ interrupted: true, success: false }));
    expect(bodies[0]).toContain("Failed");
    expect(bodies[1]).toContain("Interrupted");
  });

  it("keeps the session-end debug line for diagnostics", () => {
    const plugin = new NotifyPlugin(() => {});
    const c = ctx();
    plugin.onSessionEnd!({ sessionId: "ses_abc", logger: c.logger } as never);
    expect(c.debug.length).toBe(1);
    expect(c.debug[0]).toContain("ses_abc");
  });

  it("does not throw when the notifier itself fails", () => {
    const plugin = new NotifyPlugin(() => {
      throw new Error("no display");
    });
    const c = ctx();
    expect(() => plugin.onTurnEnd!(c, summary())).not.toThrow();
    expect(c.debug[0]).toContain("no display");
  });
});

describe("notificationCommand", () => {
  it("maps platforms to native commands", () => {
    expect(notificationCommand("darwin", "T", "B")?.cmd).toBe("osascript");
    expect(notificationCommand("linux", "T", "B")).toEqual({
      cmd: "notify-send",
      args: ["T", "B"],
    });
    const win = notificationCommand("win32", "T", "B");
    expect(win?.cmd).toBe("powershell");
    expect(win?.args.join(" ")).toContain("NotifyIcon");
    expect(win?.args.join(" ")).toContain("T");
  });

  it("escapes quotes in the Windows script", () => {
    const win = notificationCommand("win32", "O'Brien", 'say "hi"');
    const script = win?.args.at(-1) ?? "";
    expect(script).toContain("O''Brien");
    expect(script).toContain('say "hi"');
  });

  it("returns null on an unsupported platform", () => {
    expect(notificationCommand("aix", "T", "B")).toBeNull();
  });
});
