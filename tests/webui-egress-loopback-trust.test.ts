/**
 * E2: доверие loopback-клиенту (спека 2026-10-20).
 *
 * Локальный браузер оператора видит реальные пути/PII; внешний API-клиент —
 * псевдонимы. `secret` маскируется всегда (INV-L2).
 */
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config/types";
import { DEFAULT_DATA_POLICY } from "../src/modules/security/data-policy/defaults";
import { apiGuard } from "../src/modules/webui/egress";
import { broadcast, createWebUiState } from "../src/modules/webui/state";
import { isLoopbackAddress } from "../src/modules/webui/util";
import { doFetch, withServer } from "./helpers/webui-server";

const WORKSPACE = "C:\\work\\proj";
const HOST = hostname();
const SECRET = "AKIAIOSFODNN7EXAMPLE";

function config(over: Partial<typeof DEFAULT_DATA_POLICY> = {}): AppConfig {
  return {
    security: { dataPolicy: { ...DEFAULT_DATA_POLICY, ...over } },
  } as unknown as AppConfig;
}

function guard(trusted: boolean, over: Partial<typeof DEFAULT_DATA_POLICY> = {}) {
  const g = apiGuard({ config: config(over), workspace: WORKSPACE }, trusted);
  if (!g) throw new Error("guard expected");
  return g;
}

const PAYLOAD = {
  path: `${WORKSPACE}\\src\\a.ts`,
  host: HOST,
  mail: "user@example.com",
  key: SECRET,
};

describe("E2: loopback-клиент — доверенный", () => {
  it("isLoopbackAddress распознаёт v4/v6/mapped и отвергает внешние", () => {
    for (const addr of ["127.0.0.1", "127.10.0.5", "::1", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"]) {
      expect(isLoopbackAddress(addr), addr).toBe(true);
    }
    for (const addr of [undefined, "", "192.168.1.10", "10.0.0.1", "::ffff:192.168.1.10", "::2"]) {
      expect(isLoopbackAddress(addr), String(addr)).toBe(false);
    }
  });

  it("trusted guard не трогает пути/PII, но маскирует секрет", () => {
    const out = guard(true).filterClient(PAYLOAD) as typeof PAYLOAD;
    expect(out.path).toBe(PAYLOAD.path);
    expect(out.host).toBe(PAYLOAD.host);
    expect(out.mail).toBe(PAYLOAD.mail);
    expect(out.key).toBe("[SECRET]");
  });

  it("untrusted guard псевдонимизирует пути/PII и секрет", () => {
    const out = guard(false).filterClient(PAYLOAD) as typeof PAYLOAD;
    expect(out.path).toContain("<PATH:");
    expect(out.host).toContain("<HOST:");
    expect(out.mail).toContain("<PII:");
    expect(out.key).toBe("[SECRET]");
  });

  it("сервер: loopback получает реальный путь в /api/skills", async () => {
    const s = createWebUiState();
    s.config = config();
    s.workspace = WORKSPACE;
    s.skills = {
      getAvailable: () => [
        { name: "x", description: "d", sourcePath: `${WORKSPACE}\\.skills\\x\\SKILL.md` },
      ],
      getLoaded: () => [],
    };
    await withServer(s, async (base) => {
      const json = (await (await doFetch(`${base}/api/skills`)).json()) as {
        skills: Array<{ source: string }>;
      };
      expect(json.skills[0].source).toBe(`${WORKSPACE}\\.skills\\x\\SKILL.md`);
    });
  });

  it("сервер: trustLocalClients=false возвращает строгий режим даже на loopback", async () => {
    const s = createWebUiState();
    s.config = config({ trustLocalClients: false });
    s.workspace = WORKSPACE;
    s.skills = {
      getAvailable: () => [
        { name: "x", description: "d", sourcePath: `${WORKSPACE}\\.skills\\x\\SKILL.md` },
      ],
      getLoaded: () => [],
    };
    await withServer(s, async (base) => {
      const text = JSON.stringify(await (await doFetch(`${base}/api/skills`)).json());
      expect(text).not.toContain(WORKSPACE);
      expect(text).toContain("<PATH:");
    });
  });

  it("сервер: SSE локальному клиенту отдаёт реальные args, секрет — маской", async () => {
    const s = createWebUiState();
    s.config = config();
    s.workspace = WORKSPACE;
    await withServer(s, async (base) => {
      const controller = new AbortController();
      const res = await doFetch(`${base}/events`, { signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (let i = 0; i < 8 && !buf.includes("event: state"); i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
      }
      expect(buf).not.toContain("<PATH:");

      broadcast(
        {
          type: "tool_start",
          ts: 1,
          args: { path: `${WORKSPACE}\\src\\a.ts`, key: SECRET },
        },
        s,
      );
      for (let i = 0; i < 8 && !buf.includes("tool_start"); i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
      }
      const event = buf
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as { type?: string; args?: Record<string, string> })
        .find((e) => e.type === "tool_start");
      expect(event?.args?.path).toBe(`${WORKSPACE}\\src\\a.ts`);
      expect(event?.args?.key).toBe("[SECRET]");
      expect(buf).not.toContain(SECRET);
      controller.abort();
    });
  });
});
