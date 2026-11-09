import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");

describe("deployment/ops artifacts", () => {
  it("service Dockerfile exists and runs mma serve", () => {
    const p = join(root, "deploy/Dockerfile.service");
    expect(existsSync(p)).toBe(true);
    const body = readFileSync(p, "utf-8");
    expect(body).toContain("mma serve");
    expect(body).toContain("HEALTHCHECK");
  });

  it("k8s manifest has probes, rollback-safe strategy and RBAC", () => {
    const p = join(root, "deploy/k8s.yaml");
    expect(existsSync(p)).toBe(true);
    const body = readFileSync(p, "utf-8");
    expect(body).toContain("/healthz");
    expect(body).toContain("/readyz");
    expect(body).toContain("RollingUpdate");
    expect(body).toContain("kind: Role");
  });

  it("runbook documents SLO, rollback and kill-switch", () => {
    const p = join(root, "deploy/RUNBOOK.md");
    expect(existsSync(p)).toBe(true);
    const body = readFileSync(p, "utf-8");
    expect(body).toContain("SLO");
    expect(body).toContain("kubectl rollout undo");
    expect(body).toContain("killSwitch");
  });

  it("release manifest script emits version+sha", () => {
    const p = join(root, "scripts/build-release-manifest.ts");
    expect(existsSync(p)).toBe(true);
    const body = readFileSync(p, "utf-8");
    expect(body).toContain("release-manifest.json");
    expect(body).toContain("gitSha");
  });
});
