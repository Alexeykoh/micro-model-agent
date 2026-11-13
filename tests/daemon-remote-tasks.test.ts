import { describe, expect, it } from "vitest";
import { RemoteTasksClient } from "../src/modules/daemon/remote-tasks";

/** Фейковый fetch: отдаёт заданные ответы по очереди и пишет вызовы. */
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const next = responses[calls.length] ?? responses[responses.length - 1];
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

describe("daemon job client (W5)", () => {
  it("submits a job task and polls until success", async () => {
    const { impl, calls } = fakeFetch([
      { status: 202, body: { jobId: "j1", status: "queued" } },
      { status: 200, body: { jobId: "j1", status: "succeeded", result: { text: "ok" } } },
    ]);
    const client = new RemoteTasksClient({
      baseUrl: "http://daemon",
      token: "tok",
      pollMs: 0,
      fetchImpl: impl,
    });

    const job = await client.run("S1", "привет");

    expect(job.status).toBe("succeeded");
    expect(job.result?.text).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("http://daemon/v1/sessions/S1/tasks");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      input: "привет",
      mode: "job",
      output: { format: "text" },
    });
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(calls[1]?.url).toBe("http://daemon/v1/tasks/j1");
  });

  it("returns the terminal failure object", async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { jobId: "j2", status: "failed", error: { title: "boom" } } },
    ]);
    const client = new RemoteTasksClient({ baseUrl: "http://daemon", pollMs: 0, fetchImpl: impl });
    const job = await client.run("S1", "x");
    expect(job.status).toBe("failed");
    expect(job.error?.title).toBe("boom");
  });

  it("throws when submit is rejected", async () => {
    const { impl } = fakeFetch([{ status: 429, body: { title: "queue is full" } }]);
    const client = new RemoteTasksClient({ baseUrl: "http://daemon", pollMs: 0, fetchImpl: impl });
    await expect(client.run("S1", "x")).rejects.toThrow(/queue is full/);
  });
});
