import { describe, it, expect } from "vitest";
import {
  filterByScenarios,
  unknownScenarioIds,
} from "../src/modules/certification/loader";
import { mergePartialResults } from "../src/modules/certification/cli";
import type { CertScenario, ScenarioResult } from "../src/modules/certification/types";

function scenario(id: string): CertScenario {
  return {
    id,
    title: id,
    tags: ["core"],
    mode: "run",
    prompt: `do ${id}`,
    checks: [{ type: "exitCode", equals: 0 }],
  };
}

function result(id: string, status: ScenarioResult["status"]): ScenarioResult {
  return { id, title: id, status, passed: status === "pass" ? 2 : 0, of: 2 };
}

describe("filterByScenarios", () => {
  const scenarios = [scenario("2.1-read-file"), scenario("3.5-data-pipeline"), scenario("9.1-lsp-check")];

  it("keeps only requested ids (case-insensitive)", () => {
    const out = filterByScenarios(scenarios, ["3.5-DATA-pipeline"]);
    expect(out.map((s) => s.id)).toEqual(["3.5-data-pipeline"]);
  });

  it("supports multiple comma-separated ids in any order", () => {
    const out = filterByScenarios(scenarios, ["9.1-lsp-check", "2.1-read-file"]);
    expect(out.map((s) => s.id)).toEqual(["2.1-read-file", "9.1-lsp-check"]);
  });
});

describe("unknownScenarioIds", () => {
  const scenarios = [scenario("2.1-read-file")];

  it("reports unknown ids", () => {
    expect(unknownScenarioIds(scenarios, ["2.1-read-file", "nope"])).toEqual(["nope"]);
  });

  it("returns empty when all known", () => {
    expect(unknownScenarioIds(scenarios, ["2.1-READ-FILE"])).toEqual([]);
  });
});

describe("mergePartialResults", () => {
  it("replaces re-run results and preserves the rest", () => {
    const previous = [
      result("2.1-read-file", "pass"),
      result("3.5-data-pipeline", "fail"),
      result("6.1-plan-create-execute", "pass"),
    ];
    const fresh = [result("3.5-data-pipeline", "pass")];
    const merged = mergePartialResults(fresh, previous, new Set(["3.5-data-pipeline"]));
    expect(merged.map((r) => r.id).sort()).toEqual([
      "2.1-read-file",
      "3.5-data-pipeline",
      "6.1-plan-create-execute",
    ]);
    const p35 = merged.find((r) => r.id === "3.5-data-pipeline");
    expect(p35?.status).toBe("pass");
    const p21 = merged.find((r) => r.id === "2.1-read-file");
    expect(p21?.status).toBe("pass");
  });

  it("returns fresh results unchanged when nothing to preserve", () => {
    const fresh = [result("3.5-data-pipeline", "fail")];
    const merged = mergePartialResults(fresh, [], new Set(["3.5-data-pipeline"]));
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe("fail");
  });

  it("preserves skipped results too", () => {
    const previous = [
      result("1.1-question-tool", "skipped"),
      result("3.5-data-pipeline", "fail"),
    ];
    const fresh = [result("3.5-data-pipeline", "pass")];
    const merged = mergePartialResults(fresh, previous, new Set(["3.5-data-pipeline"]));
    expect(merged.map((r) => r.status)).toEqual(["pass", "skipped"]);
  });
});
