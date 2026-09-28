import { describe, it, expect } from "vitest";
import { parseVerdict, CriticClient } from "../src/modules/critic/client";
import type { LLMProvider } from "../src/llm/provider";

function providerReturning(text: string): LLMProvider {
  return {
    model: "m", contextWindow: 1000, countTokens: () => 0, listModels: async () => [],
    async *chat() {
      yield { type: "text" as const, content: text };
      yield { type: "done" as const };
    },
  };
}

describe("parseVerdict", () => {
  it("parses plain JSON", () => {
    expect(parseVerdict('{"status":"ok","summary":"fine","issues":[]}')?.status).toBe("ok");
  });
  it("repairs slightly broken JSON", () => {
    expect(parseVerdict('{"status":"concern","summary":"x","issues":[]')?.status).toBe("concern");
  });
  it("returns null on garbage", () => {
    expect(parseVerdict("not json")).toBeNull();
  });
});

describe("CriticClient", () => {
  it("fails open to null on provider error", async () => {
    const provider: LLMProvider = {
      model: "m", contextWindow: 1000, countTokens: () => 0, listModels: async () => [],
      // eslint-disable-next-line require-yield
      async *chat() { throw new Error("boom"); },
    };
    const client = new CriticClient({ provider });
    expect(await client.verify({ task: "t", changedFiles: [], commands: [], toolDigest: "" })).toBeNull();
  });
});

describe("CriticClient tool loop (Phase 2)", () => {
  const pack = { task: "t", changedFiles: ["a.ts"], commands: [], toolDigest: "✓ write_file a.ts" };

  /** Provider that yields one queued text per chat() call and counts calls. */
  function scripted(texts: string[], calls: { n: number }): LLMProvider {
    return {
      model: "m", contextWindow: 1000, countTokens: () => 0, listModels: async () => [],
      async *chat() {
        calls.n++;
        yield { type: "text" as const, content: texts[Math.min(calls.n - 1, texts.length - 1)] };
        yield { type: "done" as const };
      },
    };
  }

  const ok = '{"status":"ok","summary":"fine","issues":[]}';
  const concern = '{"status":"concern","summary":"gap","issues":[{"severity":"concern","claim":"c","problem":"p"}]}';
  const wantCheck = '{"status":"concern","summary":"gap","issues":[],"checks":[{"tool":"read_file","args":{"path":"a.ts"}}]}';
  const finalOk = '{"status":"ok","summary":"verified fine","issues":[]}';

  it("skips the loop on ok (single call, no checks)", async () => {
    const calls = { n: 0 };
    const runCheck = async () => ({ ok: true, output: "x" });
    const client = new CriticClient({ provider: scripted([ok], calls) });
    const verdict = await client.verify(pack, undefined, { runCheck });
    expect(verdict?.status).toBe("ok");
    expect(calls.n).toBe(1);
  });

  it("skips the loop without a runCheck runner", async () => {
    const calls = { n: 0 };
    const client = new CriticClient({ provider: scripted([concern], calls) });
    const verdict = await client.verify(pack);
    expect(verdict?.status).toBe("concern");
    expect(calls.n).toBe(1);
  });

  it("runs requested checks and returns the grounded final verdict", async () => {
    const calls = { n: 0 };
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const runCheck = async (tool: string, args: Record<string, unknown>) => {
      seen.push({ tool, args });
      return { ok: true, output: "file has real content" };
    };
    const client = new CriticClient({ provider: scripted([concern, wantCheck, finalOk], calls) });
    const verdict = await client.verify(pack, undefined, { runCheck });
    expect(verdict?.status).toBe("ok");
    expect(verdict?.summary).toBe("verified fine");
    expect(seen).toEqual([{ tool: "read_file", args: { path: "a.ts" } }]);
    expect(calls.n).toBe(3);
  });

  it("falls back to the first verdict when no checks are requested", async () => {
    const calls = { n: 0 };
    const client = new CriticClient({ provider: scripted([concern, concern], calls) });
    const verdict = await client.verify(pack, undefined, { runCheck: async () => ({ ok: true, output: "" }) });
    expect(verdict?.status).toBe("concern");
    expect(calls.n).toBe(2);
  });

  it("falls back to the first verdict on broken final JSON", async () => {
    const calls = { n: 0 };
    const client = new CriticClient({ provider: scripted([concern, wantCheck, "garbage!!!"], calls) });
    const verdict = await client.verify(pack, undefined, { runCheck: async () => ({ ok: true, output: "x" }) });
    expect(verdict?.status).toBe("concern");
  });

  it("parseVerdict carries checks through", async () => {
    const { parseVerdict } = await import("../src/modules/critic/client");
    const v = parseVerdict(wantCheck);
    expect(v?.checks).toEqual([{ tool: "read_file", args: { path: "a.ts" } }]);
    expect(parseVerdict(ok)?.checks).toBeUndefined();
  });
});
