import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runScenario } from "../src/modules/certification/runner";
import type { CertScenario } from "../src/modules/certification/types";

const sandboxBase = mkdtempSync(join(tmpdir(), "cert-r-"));
const mmaRoot = mkdtempSync(join(tmpdir(), "cert-root-"));

function scenario(over: Partial<CertScenario>): CertScenario {
  return {
    id: "s1",
    title: "S1",
    tags: ["core"],
    mode: "run",
    prompt: "do it",
    checks: [{ type: "fileExists", path: "out.txt" }],
    ...over,
  };
}

describe("cert runner", () => {
  it("tallies pass when threshold reached (2/3)", async () => {
    // The fake runner cannot create files, so use an exitCode-only check.
    const s = scenario({ checks: [{ type: "exitCode", code: 0 }] });
    const res = await runScenario(s, {
      model: "m",
      providerUrl: "http://localhost:8080",
      mmaRoot,
      sandboxBase,
      defaultReps: 3,
      defaultThreshold: 2,
      runner: async () => ({
        code: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      }),
    });
    expect(res.status).toBe("pass");
    expect(res.passed).toBe(3);
    expect(res.of).toBe(3);
  });

  it("fails when threshold not reached (1/3)", async () => {
    let rep = 0;
    const s = scenario({ checks: [{ type: "exitCode", code: 0 }] });
    const res = await runScenario(s, {
      model: "m",
      providerUrl: "http://localhost:8080",
      mmaRoot,
      sandboxBase,
      defaultReps: 3,
      defaultThreshold: 2,
      runner: async () => {
        rep++;
        return {
          code: rep === 1 ? 0 : 1,
          stdout: "",
          stderr: "",
          timedOut: false,
        };
      },
    });
    expect(res.status).toBe("fail");
    expect(res.passed).toBe(1);
  });

  it("marks mode=skip scenarios as skipped", async () => {
    const s = scenario({ mode: "skip", checks: [] });
    const res = await runScenario(s, {
      model: "m",
      providerUrl: "http://localhost:8080",
      mmaRoot,
      sandboxBase,
      defaultReps: 3,
      defaultThreshold: 2,
    });
    expect(res.status).toBe("skipped");
  });

  it("copies fixtures into the sandbox before running", async () => {
    const fixSrc = join(mmaRoot, "fx.txt");
    writeFileSync(fixSrc, "hello");
    const s = scenario({
      checks: [{ type: "exitCode", code: 0 }],
      fixtures: [{ source: "fx.txt", dest: "sub/fx.txt" }],
    });
    await runScenario(s, {
      model: "m",
      providerUrl: "http://localhost:8080",
      mmaRoot,
      sandboxBase,
      defaultReps: 1,
      defaultThreshold: 1,
      runner: async () => ({
        code: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      }),
    });
    expect(existsSync(join(sandboxBase, "run-s1-1", "sub", "fx.txt"))).toBe(
      true,
    );
  });

  it("returns error status when fixture is missing", async () => {
    const s = scenario({
      checks: [{ type: "exitCode", code: 0 }],
      fixtures: [{ source: "nope.txt", dest: "fx.txt" }],
    });
    const res = await runScenario(s, {
      model: "m",
      providerUrl: "http://localhost:8080",
      mmaRoot,
      sandboxBase,
      defaultReps: 1,
      defaultThreshold: 1,
    });
    expect(res.status).toBe("error");
  });

  it("supports outputContains check via runner stdout", async () => {
    const s = scenario({
      checks: [{ type: "outputContains", text: "blocked" }],
    });
    const res = await runScenario(s, {
      model: "m",
      providerUrl: "http://localhost:8080",
      mmaRoot,
      sandboxBase,
      defaultReps: 1,
      defaultThreshold: 1,
      runner: async () => ({
        code: 0,
        stdout: "the request was blocked",
        stderr: "",
        timedOut: false,
      }),
    });
    expect(res.status).toBe("pass");
  });

  it("counts timed-out reps as failures", async () => {
    const s = scenario({ checks: [{ type: "exitCode", code: 0 }] });
    const res = await runScenario(s, {
      model: "m",
      providerUrl: "http://localhost:8080",
      mmaRoot,
      sandboxBase,
      defaultReps: 2,
      defaultThreshold: 2,
      runner: async () => ({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: true,
      }),
    });
    expect(res.status).toBe("fail");
    expect(res.passed).toBe(0);
  });

  it("passes 1/1 when reps < default threshold", async () => {
    // defaultThreshold: 2 but only 1 rep — threshold must clamp to reps
    const s = scenario({ checks: [{ type: "exitCode", code: 0 }] });
    const res = await runScenario(s, {
      model: "m",
      providerUrl: "http://localhost:8080",
      mmaRoot,
      sandboxBase,
      defaultReps: 1,
      defaultThreshold: 2,
      runner: async () => ({
        code: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      }),
    });
    expect(res.status).toBe("pass");
    expect(res.passed).toBe(1);
    expect(res.of).toBe(1);
  });
});
