import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import {
  satisfiesMinimum,
  detectRuntime,
  collectEnvironment,
  checkEnvironmentRequirements,
  playwrightBrowsersDir,
} from "../src/core/environment";
import type { EnvironmentReport } from "../src/core/environment";

describe("environment", () => {
  it("satisfiesMinimum compares numeric versions", () => {
    expect(satisfiesMinimum("v22.1.0", ">=20")).toBe(true);
    expect(satisfiesMinimum("v20.0.0", ">=20")).toBe(true);
    expect(satisfiesMinimum("v19.9.9", ">=20")).toBe(false);
    expect(satisfiesMinimum("1.3.14", ">=1")).toBe(true);
    expect(satisfiesMinimum("v18.0.0", ">=18.2.0")).toBe(false);
    expect(satisfiesMinimum("v18.2.0", ">=18.2.0")).toBe(true);
    expect(satisfiesMinimum("v18.2.1", ">=18.2.0")).toBe(true);
  });

  it("detects the current runtime", () => {
    const r = detectRuntime();
    expect(["bun", "node", "unknown"]).toContain(r.runtime);
    expect(r.runtimeVersion).toBeTruthy();
    expect(r.nodeVersion).toMatch(/^v/);
    expect(r.engine).toContain(">=");
  });

  it("collects a report without config", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-env-"));
    try {
      const report = collectEnvironment({ configDir: dir, scanTools: false });
      expect(report.os.platform).toBe(process.platform);
      expect(report.paths.configDir).toBe(dir);
      expect(report.mmaVersion).toMatch(/\d+\.\d+\.\d+/);
      expect(report.provider).toBeNull();
      expect(report.playwright).not.toBeNull();
      expect(Array.isArray(report.warnings)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes provider baseUrl and reports retry config", () => {
    const report = collectEnvironment({
      configDir: join(homedir(), ".mma"),
      config: {
        model: "test-model",
        contextWindow: 32768,
        provider: { type: "openai", baseUrl: "http://localhost:1234/v1?key=sk-secret", apiKey: "sk-123" },
        retry: { maxRetries: 3, baseDelay: 1000, maxDelay: 30000, maxStreamRetries: 2, noDataTimeoutMs: 60000 },
      } as any,
      scanTools: false,
    });
    expect(report.provider?.model).toBe("test-model");
    expect(report.provider?.retry.maxStreamRetries).toBe(2);
    expect(report.provider?.baseUrl).not.toContain("sk-secret");
  });

  it("flags node runtime as a warning", () => {
    const base = collectEnvironment({ configDir: join(homedir(), ".mma"), scanTools: false });
    const nodeReport: EnvironmentReport = {
      ...base,
      runtime: {
        runtime: "node",
        runtimeVersion: "v22.16.0",
        nodeVersion: "v22.16.0",
        engine: ">=20",
        engineOk: true,
      },
      tools: { bun: "1.3.14", node: "v22.16.0", git: "git version 2.40", python: "Python 3.12" },
      warnings: [],
    };
    const warnings = checkEnvironmentRequirements(nodeReport);
    expect(warnings.some((w) => w.includes("Node"))).toBe(true);
  });

  it("flags low runtime version as a warning", () => {
    const base = collectEnvironment({ configDir: join(homedir(), ".mma"), scanTools: false });
    const oldReport: EnvironmentReport = {
      ...base,
      runtime: {
        runtime: "bun",
        runtimeVersion: "1.0.0",
        nodeVersion: "v18.0.0",
        engine: ">=20",
        engineOk: false,
      },
      tools: { bun: "1.0.0", node: "v18.0.0", git: "missing", python: "missing" },
      warnings: [],
    };
    const warnings = checkEnvironmentRequirements(oldReport);
    expect(warnings.some((w) => w.includes("engines"))).toBe(true);
    expect(warnings.some((w) => w.includes("git"))).toBe(true);
  });

  it("warns about missing playwright browsers only when browser is enabled", () => {
    const base = collectEnvironment({ configDir: join(homedir(), ".mma"), scanTools: false });
    const browserOn: EnvironmentReport = {
      ...base,
      features: { browser: true },
      playwright: { installed: true, version: "1.62.0", browsersDir: "/nonexistent/ms-playwright", browsersInstalled: false },
      warnings: [],
    };
    const browserOff: EnvironmentReport = {
      ...browserOn,
      features: { browser: false },
    };
    expect(checkEnvironmentRequirements(browserOn).some((w) => w.includes("Playwright"))).toBe(true);
    expect(checkEnvironmentRequirements(browserOff).some((w) => w.includes("Playwright"))).toBe(false);
  });

  it("resolves playwright browsers dir with env override", () => {
    const saved = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = "/custom/browsers";
    try {
      expect(playwrightBrowsersDir()).toBe("/custom/browsers");
    } finally {
      if (saved === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = saved;
    }
  });
});