import { describe, it, expect } from "vitest";
import { checkSuccessClaim } from "../src/modules/hallucination/success-claim";

describe("checkSuccessClaim", () => {
  it("flags a publish claim against a 404 + stale latest", () => {
    const hit = checkSuccessClaim("✅ MMA 2.8.0 опубликована на npm", [
      { name: "bash", ok: true, text: '{"latest": "2.5.0"}' },
      { name: "bash", ok: false, text: "npm error 404 No match found for version 2.8.0" },
    ]);
    expect(hit).not.toBeNull();
    expect(hit!.snippet).toContain("404");
  });

  it("passes when the answer already hedges", () => {
    const hit = checkSuccessClaim(
      "Package staged, the registry processes it asynchronously and latest will appear in a few minutes",
      [{ name: "bash", ok: false, text: "npm error 404 No match found" }],
    );
    expect(hit).toBeNull();
  });

  it("passes when the last tools are clean", () => {
    const hit = checkSuccessClaim("Done, all tests pass", [
      { name: "bash", ok: true, text: "2644 pass, 0 fail" },
    ]);
    expect(hit).toBeNull();
  });

  it("passes without a success claim even if tools failed", () => {
    const hit = checkSuccessClaim("The publish failed, here is the log", [
      { name: "bash", ok: false, text: "npm error 409 Conflict" },
    ]);
    expect(hit).toBeNull();
  });

  it("ignores empty tool outputs", () => {
    const hit = checkSuccessClaim("Done", [
      { name: "bash", ok: true, text: "   \n  " },
    ]);
    expect(hit).toBeNull();
  });

  it("ignores stale plan-bookkeeping failures against a success claim (ses_mupgenhq_75f66l)", () => {
    // Честное «тесты прошли» ветировалось stale-ошибкой `plan re-plan`
    // («Длина checks должна совпадать») — фейл блокнота, а не исхода задачи.
    const hit = checkSuccessClaim("Результат: ✅ Тесты прошли успешно!", [
      { name: "plan", ok: false, text: "Длина checks должна совпадать с числом шагов" },
      { name: "bash", ok: true, text: "2 pass, 0 fail" },
      { name: "plan_step", ok: true, text: "step 3 → done" },
    ]);
    expect(hit).toBeNull();
  });

  it("ignores a lone plan failure with no other evidence", () => {
    const hit = checkSuccessClaim("Done, all tests pass", [
      { name: "todo", ok: false, text: "Error: subtask id not found" },
    ]);
    expect(hit).toBeNull();
  });

  it("still flags a real failure next to plan noise", () => {
    const hit = checkSuccessClaim("Done, all tests pass", [
      { name: "plan", ok: false, text: "Длина checks должна совпадать с числом шагов" },
      { name: "bash", ok: false, text: "npm error 404 No match found" },
    ]);
    expect(hit).not.toBeNull();
    expect(hit!.snippet).toContain("404");
  });
});
