import { describe, it, expect } from "vitest";
import { scanCorpus } from "../../src/core/context/scan-corpus";
import type { Message } from "../../src/llm/provider";

// Провайдер-эхо: на MAP возвращает FINDING, на синтез — SYNTH. Синтез-вызов
// опознаём по системному промпту (`DEFAULT_SYNTHESIS_SYSTEM_PROMPT` содержит
// "combining evidence").
function mockProvider(): any {
  return {
    chat: async function* (messages: Message[]) {
      const user = messages.find((m) => m.role === "user")?.content as string;
      const system = messages.find((m) => m.role === "system")?.content as string;
      const isSynth = typeof system === "string" && system.includes("combining evidence");
      const text = user.includes("Text:") ? user.split("Text:")[1] : user;
      if (isSynth) yield { type: "text", content: "SYNTH" };
      else yield { type: "text", content: `FINDING:${text.trim().slice(0, 20)}` };
    },
  };
}

describe("scanCorpus", () => {
  it("maps each file to a finding and reduces to a synthesis", async () => {
    const files = { "a.md": "alpha content", "b.md": "beta content" };
    const res = await scanCorpus(mockProvider(), {
      question: "q",
      files: Object.keys(files),
      readFile: (p) => files[p],
      maxFanout: 8,
    });
    expect(res.scanned).toBe(2);
    expect(res.findings.map((f) => f.path).sort()).toEqual(["a.md", "b.md"]);
    expect(res.synthesis).toBe("SYNTH");
  });

  it("bounds fanout by recursively partitioning directories (OO-9)", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`d${i % 2}/f${i}.md`] = `content ${i}`;
    const res = await scanCorpus(mockProvider(), {
      question: "q",
      files: Object.keys(files),
      readFile: (p) => files[p],
      maxFanout: 2,
    });
    expect(res.scanned).toBe(6); // all reached via hierarchy
    expect(res.findings.length).toBe(6);
    expect(res.maxFanoutObserved).toBeLessThanOrEqual(2);
  });

  it("skips unreadable files without failing the scan", async () => {
    const res = await scanCorpus(mockProvider(), {
      question: "q",
      files: ["ok.md", "gone.md"],
      readFile: (p) => {
        if (p === "gone.md") throw new Error("ENOENT");
        return "ok content";
      },
    });
    expect(res.findings.map((f) => f.path)).toEqual(["ok.md"]);
  });
});
