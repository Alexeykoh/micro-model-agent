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

describe("service health routes", () => {
  it("serves liveness and resolves the base url", async () => {
    const svc = startAgentService(makeDeps());
    stop = svc.stop;
    const url = await svc.url;
    const res = await httpJson(`${url}/v1/health`);
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("ok");
  });

  it("returns a problem+json for an unknown route", async () => {
    const svc = startAgentService(makeDeps());
    stop = svc.stop;
    const url = await svc.url;
    const res = await httpJson(`${url}/v1/nope`);
    expect(res.status).toBe(404);
    expect(String(res.headers["content-type"])).toContain("application/problem+json");
  });

  it("rejects a wrong bearer token when a token is configured", async () => {
    const svc = startAgentService(makeDeps({ token: "secret" }));
    stop = svc.stop;
    const url = await svc.url;
    const res = await httpJson(`${url}/v1/sessions`);
    expect(res.status).toBe(401);
  });

  it("reports not-ready when the provider is unreachable", async () => {
    const deps = makeDeps();
    deps.config.provider.baseUrl = "http://127.0.0.1:1/v1";
    const svc = startAgentService(deps);
    stop = svc.stop;
    const url = await svc.url;
    const res = await httpJson(`${url}/v1/ready`);
    expect(res.status).toBe(503);
    expect(String(res.headers["content-type"])).toContain("application/problem+json");
  });

  it("refuses a non-loopback bind without a token", async () => {
    const svc = startAgentService(makeDeps({ host: "0.0.0.0" }));
    stop = svc.stop;
    await expect(svc.url).rejects.toThrow();
  });
});
