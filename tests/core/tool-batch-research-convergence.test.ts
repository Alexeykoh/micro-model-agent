import { describe, it, expect } from "vitest";
import { ToolBatchExecutor } from "../../src/core/agent/tool-batch";
import { createLoopState } from "../../src/core/agent/loop-state";
import { MAX_RESEARCH_BATCHES } from "../../src/core/agent/constants";
import { makeToolBatchDeps } from "../helpers/tool-batch-deps";

// Session ses_mv44qabg_s1przq: 42 web_search + 36 web_fetch in one turn with no
// artifact. A long run of web-only batches now yields a one-time "converge"
// directive (no hard stop — the project already reverted a broad read-only
// budget; this set is external-web only and resets on any non-web tool).
function makeCase() {
  const added: string[] = [];
  const ex = new ToolBatchExecutor(
    makeToolBatchDeps({ execute: async () => ({ success: true, output: "out" }), added }),
  );
  const state = createLoopState();
  let seq = 0;
  const run = (name: string) =>
    ex.execute(
      state,
      [{ id: String(++seq), name, arguments: { q: `x${seq}` } }],
      new Set(),
      "",
      "",
      "task",
    );
  return { added, state, run };
}

const isConverge = (m: string): boolean =>
  m.includes("web lookups") || m.includes("веб-запросов");

describe("ToolBatchExecutor web-research convergence", () => {
  it(`directs convergence after ${MAX_RESEARCH_BATCHES} web-only batches`, async () => {
    const { added, state, run } = makeCase();
    for (let n = 0; n < MAX_RESEARCH_BATCHES - 1; n++) await run("web_search");
    expect(state.consecutiveResearchBatches).toBe(MAX_RESEARCH_BATCHES - 1);
    expect(added.some(isConverge)).toBe(false);

    await run("web_fetch");
    expect(state.consecutiveResearchBatches).toBe(MAX_RESEARCH_BATCHES);
    expect(added.some(isConverge)).toBe(true);
  });

  it("keeps the streak on a single interleaved local read (§1.4)", async () => {
    const { added, run, state } = makeCase();
    for (let n = 0; n < MAX_RESEARCH_BATCHES - 1; n++) {
      await run("web_search");
      await run("read_file");
    }
    // Чередование web → read не обнуляет серию: иначе директива недостижима.
    expect(state.consecutiveResearchBatches).toBe(MAX_RESEARCH_BATCHES - 1);
    await run("web_fetch");
    expect(added.some(isConverge)).toBe(true);
  });

  it("resets the streak after two non-web batches with a result", async () => {
    const { added, run, state } = makeCase();
    for (let n = 0; n < MAX_RESEARCH_BATCHES; n++) await run("web_search");
    expect(added.some(isConverge)).toBe(true);
    await run("read_file");
    expect(state.consecutiveResearchBatches).toBe(MAX_RESEARCH_BATCHES);
    await run("write_file");
    expect(state.consecutiveResearchBatches).toBe(0);
    expect(state.researchNudged).toBe(false);
  });

  it("emits the directive only once per streak", async () => {
    const { added, run } = makeCase();
    for (let n = 0; n < MAX_RESEARCH_BATCHES + 4; n++) await run("web_search");
    expect(added.filter(isConverge)).toHaveLength(1);
  });
});
