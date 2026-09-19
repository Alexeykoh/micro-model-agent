import { describe, it, expect } from "vitest";
import {
  isTestOrSpecPath,
  createArtifactChurnState,
  recordArtifactWrite,
  testChurnFile,
  TEST_CHURN_THRESHOLD,
} from "../src/core/agent/artifact-progress";

describe("isTestOrSpecPath", () => {
  it("detects test/spec files across common conventions", () => {
    expect(isTestOrSpecPath("src/foo.test.ts")).toBe(true);
    expect(isTestOrSpecPath("src/foo.spec.js")).toBe(true);
    expect(isTestOrSpecPath("tests/helpers.ts")).toBe(true);
    expect(isTestOrSpecPath("spec/models/user_spec.rb")).toBe(true);
    expect(isTestOrSpecPath("pkg/service_test.go")).toBe(true);
    expect(isTestOrSpecPath("test_math.py")).toBe(true);
    expect(isTestOrSpecPath("src/main/java/UserTest.java")).toBe(true);
    expect(isTestOrSpecPath("src\\__tests__\\a.tsx")).toBe(true);
  });

  it("does not flag production files", () => {
    expect(isTestOrSpecPath("src/game.ts")).toBe(false);
    expect(isTestOrSpecPath("src/App.tsx")).toBe(false);
    expect(isTestOrSpecPath("README.md")).toBe(false);
    expect(isTestOrSpecPath("contest/entry.ts")).toBe(false);
  });
});

describe("artifact churn tracker", () => {
  it("nudges after repeated test writes with no production change", () => {
    const state = createArtifactChurnState();
    recordArtifactWrite(state, "src/game.test.ts");
    recordArtifactWrite(state, "src/game.test.ts");
    expect(testChurnFile(state)).toBeNull(); // below threshold
    recordArtifactWrite(state, "src/game.test.ts");
    expect(testChurnFile(state)).toBe("src/game.test.ts");
  });

  it("a production write resets the streak", () => {
    const state = createArtifactChurnState();
    for (let i = 0; i < TEST_CHURN_THRESHOLD; i++) recordArtifactWrite(state, "a.test.ts");
    expect(testChurnFile(state)).toBe("a.test.ts");
    recordArtifactWrite(state, "src/impl.ts");
    expect(testChurnFile(state)).toBeNull();
  });

  it("does not re-nudge once flagged", () => {
    const state = createArtifactChurnState();
    for (let i = 0; i < TEST_CHURN_THRESHOLD; i++) recordArtifactWrite(state, "a.spec.ts");
    expect(testChurnFile(state)).toBe("a.spec.ts");
    state.nudged = true;
    expect(testChurnFile(state)).toBeNull();
  });
});
