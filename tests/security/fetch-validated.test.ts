import { describe, it, expect, afterEach } from "vitest";
import {
  BlockedRedirectError,
  fetchValidated,
} from "../../src/modules/security/network-validator";

const realFetch = globalThis.fetch;
const cfg = { enabled: true, deniedDomains: [], allowedDomains: [] } as any;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchValidated (SSRF-safe redirects)", () => {
  it("returns the final response for an allowed URL", async () => {
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    const { response, finalUrl } = await fetchValidated("http://example.com/a", cfg);
    expect(response.status).toBe(200);
    expect(finalUrl).toBe("http://example.com/a");
  });

  it("follows a redirect to another public host", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u === "http://example.com/a") {
        return new Response(null, { status: 302, headers: { location: "http://example.org/b" } });
      }
      return new Response("done", { status: 200 });
    }) as typeof fetch;

    const { response, finalUrl } = await fetchValidated("http://example.com/a", cfg);
    expect(response.status).toBe(200);
    expect(finalUrl).toBe("http://example.org/b");
  });

  it("blocks a redirect that hops to a private address", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } })) as typeof fetch;

    await expect(fetchValidated("http://example.com/a", cfg)).rejects.toBeInstanceOf(
      BlockedRedirectError,
    );
  });

  it("blocks a redirect to the cloud metadata endpoint", async () => {
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 301,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      })) as typeof fetch;

    await expect(fetchValidated("http://example.com/", cfg)).rejects.toBeInstanceOf(
      BlockedRedirectError,
    );
  });

  it("stops after too many redirects", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 302, headers: { location: "http://example.com/next" } })) as typeof fetch;

    await expect(fetchValidated("http://example.com/a", cfg)).rejects.toBeInstanceOf(
      BlockedRedirectError,
    );
  });
});
