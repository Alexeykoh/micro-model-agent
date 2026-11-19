import { describe, it, expect } from "vitest";
import { isInfraError, isTransientError } from "../../../src/modules/execution/transient-error";

describe("isTransientError", () => {
  it("classifies provider mid-stream failures as transient", () => {
    // Наблюдалось в ses_muz7sg1l_0ankgu: обрыв стрима не матчил ни один
    // паттерн, и сабтаск падал с первой попытки без backoff.
    expect(
      isTransientError("Provider returned an error mid-stream: Failed to load model"),
    ).toBe(true);
    expect(isTransientError("LLM stream stalled — no data for 180000ms")).toBe(true);
  });

  it("classifies local engine load failures as transient", () => {
    expect(
      isTransientError(
        'LLM API error 400 (Bad Request): {"error":{"message":"Failed to load model \\"qwen/qwen3.5-9b\\". Error: Engine protocol startup was aborted."}}',
      ),
    ).toBe(true);
  });

  it("keeps non-transient content errors non-transient", () => {
    expect(isTransientError("File not found: src/missing.ts")).toBe(false);
    expect(isTransientError("No matching tools")).toBe(false);
  });

  it("still recognizes the classic transport failures", () => {
    expect(isTransientError("ECONNREFUSED 127.0.0.1:1234")).toBe(true);
    expect(isTransientError("HTTP 503")).toBe(true);
    expect(isTransientError("Request timed out")).toBe(true);
  });
});

describe("isInfraError", () => {
  it("flags backend/transport failures", () => {
    expect(isInfraError("Provider returned an error mid-stream: engine aborted")).toBe(true);
    expect(isInfraError("Failed to load model \"qwen/qwen3.5-9b\"")).toBe(true);
    expect(isInfraError("LLM API error 500 (Server Error)")).toBe(true);
    expect(isInfraError("fetch failed")).toBe(true);
  });

  it("does not flag task-level failures", () => {
    expect(isInfraError("Assertion failed: expected 3 files, got 1")).toBe(false);
    expect(isInfraError("Scope denied for src/app.ts")).toBe(false);
    expect(isInfraError("")).toBe(false);
  });
});
