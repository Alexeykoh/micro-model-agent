import { describe, expect, it } from "bun:test";
import { createWebUiState } from "../src/modules/webui/state";
import { withServer, postJson, doFetch } from "./helpers/webui-server";
import type { LspDiagnosis } from "../src/modules/lsp/diagnose";

const DIAG: LspDiagnosis = {
  enabled: true,
  offline: false,
  projectRoot: "/proj",
  servers: [
    {
      language: "typescript",
      command: "npx",
      args: [],
      enabled: true,
      applicable: true,
      autoInstall: true,
      probed: true,
      ok: true,
      reason: "ok",
    },
  ],
};

async function getJson(base: string, path: string): Promise<{ status: number; json: any }> {
  const res = await doFetch(base + path);
  return { status: res.status, json: await res.json() };
}

describe("webui LSP doctor API", () => {
  it("GET returns 503 when no LSP module is wired", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const r = await getJson(base, "/api/lsp/doctor");
      expect(r.status).toBe(503);
    });
  });

  it("GET returns an empty cache before any check", async () => {
    const s = createWebUiState();
    s.lspDiagnose = async () => DIAG;
    await withServer(s, async (base) => {
      const r = await getJson(base, "/api/lsp/doctor");
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ diagnosis: null, probing: false });
    });
  });

  it("POST runs the diagnosis, caches it and clears the probing flag", async () => {
    const s = createWebUiState();
    let calls = 0;
    s.lspDiagnose = async () => {
      calls += 1;
      return DIAG;
    };
    await withServer(s, async (base) => {
      const post = await postJson(base, "/api/lsp/doctor");
      expect(post.status).toBe(202);
      // Fire-and-forget: wait a tick for the promise chain to settle.
      await new Promise((r) => setTimeout(r, 10));
      const r = await getJson(base, "/api/lsp/doctor");
      expect(r.json.diagnosis).toMatchObject({ projectRoot: "/proj" });
      expect(r.json.probing).toBe(false);
    });
    expect(calls).toBe(1);
  });

  it("POST is single-flight while a check is running", async () => {
    const s = createWebUiState();
    let calls = 0;
    let release: () => void = () => {};
    s.lspDiagnose = () =>
      new Promise<LspDiagnosis>((resolve) => {
        calls += 1;
        release = () => resolve(DIAG);
      });
    await withServer(s, async (base) => {
      const first = await postJson(base, "/api/lsp/doctor");
      const second = await postJson(base, "/api/lsp/doctor");
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      const r = await getJson(base, "/api/lsp/doctor");
      expect(r.json.probing).toBe(true);
      release();
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    expect(s.lspProbing).toBe(false);
  });

  it("POST returns 503 when no LSP module is wired", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const r = await postJson(base, "/api/lsp/doctor");
      expect(r.status).toBe(503);
    });
  });

  it("a failed diagnosis clears probing and keeps the cache", async () => {
    const s = createWebUiState();
    s.lspDoctor = DIAG;
    s.lspDiagnose = async () => {
      throw new Error("boom");
    };
    await withServer(s, async (base) => {
      const r = await postJson(base, "/api/lsp/doctor");
      expect(r.status).toBe(202);
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.lspProbing).toBe(false);
    expect(s.lspDoctor).toBe(DIAG);
  });
});
