import { describe, it, expect } from "bun:test";
import { parseMessageBody } from "../src/modules/webui/util";
import { RunPool } from "../src/runtime/run-pool/run-pool";
import { applyClientTz } from "../src/core/system-prompt";

const TZ = { timeZone: "Asia/Yekaterinburg", utcOffset: "+05:00" };

function depsWith(systemContent: string) {
  return {
    config: { autoPlan: false, security: { enabled: false }, mcpServers: {}, lsp: { enabled: false } },
    baseDir: "/tmp",
    profileCompressed: "prof",
    promptBlocks: [
      { source: "core", label: "system", content: systemContent, priority: "critical", essential: true, estimatedTokens: 5 },
    ],
  } as never;
}

describe("client timezone end-to-end (B18b)", () => {
  it("parseMessageBody passes a valid clientTz through", () => {
    const body = parseMessageBody(JSON.stringify({ text: "hi", clientTz: TZ }));
    expect(body).toEqual({ text: "hi", images: [], clientTz: TZ });
  });

  it("parseMessageBody ignores a malformed clientTz without failing the message", () => {
    const body = parseMessageBody(JSON.stringify({ text: "hi", clientTz: { timeZone: "", utcOffset: "xx" } }));
    expect(body).toEqual({ text: "hi", images: [] });
    const missing = parseMessageBody(JSON.stringify({ text: "hi" }));
    expect(missing).toEqual({ text: "hi", images: [] });
  });

  it("pool stashes the latest tz per session and forgets on drop", () => {
    const pool = new RunPool();
    expect(pool.getClientTz("s1")).toBeUndefined();
    pool.setClientTz("s1", TZ);
    expect(pool.getClientTz("s1")).toEqual(TZ);
    pool.setClientTz("s1", { timeZone: "UTC", utcOffset: "+00:00" });
    expect(pool.getClientTz("s1")?.timeZone).toBe("UTC");
    pool.drop("s1");
    expect(pool.getClientTz("s1")).toBeUndefined();
  });

  it("applyClientTz rebuilds the system date once per change", () => {
    const deps = depsWith("STALE");
    expect(applyClientTz(deps, TZ)).toBe(true);
    const content = (deps.promptBlocks as Array<{ content: string }>)[0].content;
    expect(content).toContain("(user local time)");
    expect(content).not.toContain("STALE");
    // Тот же пояс — no-op, prefix-cache не рвём.
    expect(applyClientTz(deps, { ...TZ })).toBe(false);
    // Сброс — назад к серверному с меткой.
    expect(applyClientTz(deps, undefined)).toBe(true);
    expect((deps.promptBlocks as Array<{ content: string }>)[0].content).toContain("(server local time)");
  });
});
