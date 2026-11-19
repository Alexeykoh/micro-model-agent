import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config/types";
import { DEFAULT_DATA_POLICY } from "../src/modules/security/data-policy/defaults";
import { broadcast } from "../src/modules/webui/state";
import { createWebUiState } from "../src/modules/webui/state";
import { doFetch, withServer } from "./helpers/webui-server";

const WORKSPACE = "C:\\work\\proj";
const HOST = hostname();

/**
 * Live-конфиг с включённой политикой (web читает его на запрос).
 * `trustLocalClients: false` — эти кейсы проверяют внешнего API-клиента;
 * доверенный loopback-клиент — в `webui-egress-loopback-trust.test.ts`.
 */
function config(over: Partial<typeof DEFAULT_DATA_POLICY> = {}): AppConfig {
  return {
    security: { dataPolicy: { ...DEFAULT_DATA_POLICY, trustLocalClients: false, ...over } },
  } as unknown as AppConfig;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Читает SSE до появления маркера (событие может прийти не в первом чанке). */
async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  maxReads = 8,
): Promise<string> {
  let buf = "";
  for (let i = 0; i < maxReads; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    if (buf.includes(needle)) break;
  }
  return buf;
}

describe("E2 web: REST/SSE egress filter", () => {
  it("`/api/skills` не отдаёт абсолютный корень workspace", async () => {
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
      const res = await doFetch(`${base}/api/skills`);
      const text = JSON.stringify(await res.json());
      expect(text).not.toContain(WORKSPACE);
      expect(text).toContain("<PATH:");
      // Относительный остаток сохранён (prefix-режим), ресурс остаётся полезным.
      expect(text).toContain(".skills");
    });
  });

  it("kill-switch: при enabled=false пути не редактируются", async () => {
    const s = createWebUiState();
    s.config = config({ enabled: false });
    s.workspace = WORKSPACE;
    s.skills = {
      getAvailable: () => [{ name: "x", sourcePath: `${WORKSPACE}\\.skills\\x\\SKILL.md` }],
      getLoaded: () => [],
    };
    await withServer(s, async (base) => {
      const json = (await (await doFetch(`${base}/api/skills`)).json()) as {
        skills: Array<{ source: string }>;
      };
      expect(json.skills[0].source).toBe(`${WORKSPACE}\\.skills\\x\\SKILL.md`);
    });
  });

  it("`/api/file` сканирует тело значения (путь, hostname, e-mail)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-web-egress-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "note.txt"),
      `workspace=${dir}\nhost=${HOST}\nmail=user@example.com\n`,
      "utf-8",
    );
    const s = createWebUiState();
    s.config = config();
    s.workspace = dir;
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/file?path=note.txt`);
      const text = await res.text();
      expect(text).not.toContain(dir);
      expect(text).not.toContain(HOST);
      expect(text).not.toContain("user@example.com");
      expect(text).toContain("<PATH:");
    });
  });

  it("SSE редактирует события, но сохранённое событие не меняет (INV-D7)", async () => {
    const s = createWebUiState();
    s.config = config();
    s.workspace = WORKSPACE;
    await withServer(s, async (base) => {
      const controller = new AbortController();
      const res = await doFetch(`${base}/events`, { signal: controller.signal });
      const reader = res.body!.getReader();
      // Greeting (state) уже отфильтрован.
      const greeting = await readSseUntil(reader, "event: state");
      expect(greeting).not.toContain(WORKSPACE);

      const ev = {
        type: "tool_start",
        ts: 1,
        args: { path: `${WORKSPACE}\\src\\a.ts`, host: HOST, mail: "user@example.com" },
      };
      broadcast(ev, s);
      const streamed = await readSseUntil(reader, "tool_start");
      expect(streamed).not.toContain(WORKSPACE);
      expect(streamed).not.toContain(HOST);
      expect(streamed).not.toContain("user@example.com");
      expect(streamed).toContain("<PATH:");

      // Источник не мутирован: редакция — копия для конкретного клиента.
      expect(ev.args.path).toBe(`${WORKSPACE}\\src\\a.ts`);
      expect(ev.args.mail).toBe("user@example.com");
      controller.abort();
    });
  });
});
