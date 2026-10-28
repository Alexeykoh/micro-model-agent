// Guard: проба готовности не упирается в собственный rate limit.
//
// Регресс из стресс-теста (волна 14): четыре запроса `/v1/ready` за ~5 с давали
// 429 «readiness probe rate limit exceeded» с `retry_after_ms ≈ 48 с`, хотя
// результат пробы кэшируется на 30 с и LLM-вызов делается один раз. Для
// k8s/LB с интервалом 1–2 с это выглядело как «сервис недоступен».
import { afterEach, describe, expect, it } from "vitest";
import { startAgentService } from "../../src/modules/service/module";
import type { ServiceDeps } from "../../src/modules/service/state";
import { DEFAULTS } from "../../src/config/defaults";
import type { Agent } from "../../src/core/agent";
import { httpJson } from "./http-client";

function makeDeps(overrides: Partial<ServiceDeps> = {}): ServiceDeps {
  const config = structuredClone(DEFAULTS);
  config.service.host = "127.0.0.1";
  config.service.port = 0;
  config.service.token = undefined;
  return { agent: {} as unknown as Agent, config, ...overrides };
}

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

describe("readiness: бюджет и кэш", () => {
  it("частые пробы из кэша не дают 429 и не дёргают провайдера", async () => {
    let calls = 0;
    const deps = makeDeps();
    deps.preflight = async () => {
      calls += 1;
      return { ok: true, reason: "ok" };
    };
    const svc = startAgentService(deps);
    stop = svc.stop;
    const url = await svc.url;

    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await httpJson(`${url}/v1/ready`);
      statuses.push(res.status);
    }

    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(calls).toBe(1);
  });
});
