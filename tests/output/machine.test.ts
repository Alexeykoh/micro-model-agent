import { describe, it, expect, vi, afterEach } from "vitest";
import { writeMachineJson } from "../../src/output/machine";

describe("writeMachineJson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes pretty JSON with a trailing newline to stdout", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    writeMachineJson({ a: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('{\n  "a": 1\n}\n');
  });
});
