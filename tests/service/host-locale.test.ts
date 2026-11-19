/**
 * W9: `X-Mma-Locale` на проводе. Сервер отвечает на языке клиента, не трогая
 * локаль процесса и других клиентов (спека §13).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../../src/core/types";
import { startAgentService } from "../../src/modules/service/module";
import { setLocale } from "../../src/i18n/index";
import { httpJson } from "./http-client";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./harness";

let dir: string;
let stop: (() => void) | undefined;
let base: string;
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
  setLocale("en");
  const svc = startAgentService(makeServiceDeps({ dir, agent: idleAgent() }));
  stop = svc.stop;
  base = await svc.url;
  sessionId = await firstSessionId(base);
});

afterEach(() => {
  stop?.();
  stop = undefined;
  cleanupServiceDir(dir);
  setLocale("en");
});

async function unsupported(locale?: string) {
  return httpJson(`${base}/v1/host/sessions/${sessionId}/command`, {
    method: "POST",
    json: { line: "/nope" },
    ...(locale ? { headers: { "X-Mma-Locale": locale } } : {}),
  });
}

describe("X-Mma-Locale on the host wire (W9)", () => {
  it("answers in the client locale", async () => {
    const ru = await unsupported("ru");
    expect(ru.status).toBe(200);
    expect(String(ru.json.error)).toContain("неизвестная команда");

    const en = await unsupported("en");
    expect(String(en.json.error)).toContain("unknown command");
  });

  it("falls back to the process locale for a missing or unknown header", async () => {
    const none = await unsupported();
    expect(String(none.json.error)).toContain("unknown command");

    const unknown = await unsupported("de");
    expect(String(unknown.json.error)).toContain("unknown command");
  });

  it("does not leak the request locale into the process", async () => {
    await unsupported("ru");
    const after = await unsupported();
    expect(String(after.json.error)).toContain("unknown command");
  });
});
