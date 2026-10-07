import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { webFetchTool } from "../../src/tools/web-fetch";

// Hermetic: `web_fetch` calls the process-global `fetch`. `bun test` runs test
// files concurrently in one process, and other suites swap `global.fetch`
// (LM Studio probes answer 404 to unrelated URLs), so a live-network call here
// races a neighbour's mock. Stub `fetch` per test instead of hitting zed.dev.
let originalFetch: typeof globalThis.fetch;

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function stubFetch(responder: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = ((url: unknown) => {
    try {
      return Promise.resolve(responder(String(url)));
    } catch (e) {
      return Promise.reject(e);
    }
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// > MIN_CONTENT_CHARS (200) so the page is not treated as a JS shell.
const MAIN_TEXT = "Zen is a high-performance multiplayer code editor. ".repeat(6);

describe("web_fetch tool", () => {
  it("fetches a page and cleans it to markdown (no script/style)", async () => {
    stubFetch(() =>
      htmlResponse(
        `<html><head><style>.x{color:red}</style><script>window.y=1</script></head>` +
          `<body><nav>Home About</nav><main><p>${MAIN_TEXT}</p></main>` +
          `<footer>Copyright</footer></body></html>`,
      ),
    );

    const result = await webFetchTool.handler({} as any, { url: "https://zed.dev/" });

    expect(result.success).toBe(true);
    expect(result.output).toContain("high-performance multiplayer code editor");
    expect(result.output).not.toContain("<script>");
    expect(result.output).not.toContain("<style>");
  });

  it("truncates content larger than the response cap with a marker", async () => {
    stubFetch(() => htmlResponse(`<main><p>${"lorem ipsum ".repeat(2000)}</p></main>`));

    const result = await webFetchTool.handler({} as any, { url: "https://zed.dev/" });

    expect(result.success).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(15100);
    expect(result.output).toContain("truncated");
  });

  it("surfaces a non-OK HTTP response as a failure", async () => {
    stubFetch(() => new Response("nope", { status: 404 }));

    const result = await webFetchTool.handler({} as any, { url: "https://zed.dev/" });

    expect(result.success).toBe(false);
    expect(result.output).toContain("404");
  });

  it("handles request errors gracefully", async () => {
    stubFetch(() => {
      throw new Error("network down");
    });

    const result = await webFetchTool.handler({} as any, {
      url: "https://this-domain-does-not-exist-12345.com",
    });

    expect(result.success).toBe(false);
  });
});
