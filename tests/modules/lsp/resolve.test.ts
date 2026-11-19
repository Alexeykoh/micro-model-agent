import { describe, expect, it } from "bun:test";
import {
  extractBinaryFromNpxArgs,
  isPackageVersion,
  isOfflineLsp,
  resolveNpxLaunch,
} from "../../../src/modules/lsp/resolve";

const TS_ARGS = [
  "--yes",
  "--package",
  "typescript-language-server",
  "--package",
  "typescript@5",
  "typescript-language-server",
  "--stdio",
];

const ANGULAR_ARGS = [
  "--yes",
  "--package",
  "@angular/language-server",
  "--package",
  "typescript@5",
  "ngserver",
  "--stdio",
  "--tsProbeLocations",
  "./node_modules",
  "--ngProbeLocations",
  "./node_modules",
];

describe("resolveNpxLaunch", () => {
  it("uses a globally installed binary and strips the npx wrapper", () => {
    const launch = resolveNpxLaunch("npx", TS_ARGS, (n) =>
      n === "typescript-language-server" ? "/usr/bin/tls" : null,
    );
    expect(launch).toMatchObject({
      command: "typescript-language-server",
      args: ["--stdio"],
      binaryName: "typescript-language-server",
      binaryOnPath: true,
      useNpxFallback: false,
    });
  });

  it("falls back to npx when the binary is not on PATH", () => {
    const launch = resolveNpxLaunch("npx", TS_ARGS, () => null);
    expect(launch.command).toBe("npx");
    expect(launch.useNpxFallback).toBe(true);
    expect(launch.binaryOnPath).toBe(false);
  });

  it("leaves angular-style npx args untouched (tail server args)", () => {
    const launch = resolveNpxLaunch("npx", ANGULAR_ARGS, () => "/x");
    expect(launch.command).toBe("npx");
    expect(launch.binaryName).toBeNull();
    expect(launch.useNpxFallback).toBe(true);
    expect(launch.args).toEqual(ANGULAR_ARGS);
  });

  it("does not touch non-npx commands", () => {
    const launch = resolveNpxLaunch("rust-analyzer", [], () => "/x");
    expect(launch).toMatchObject({
      command: "rust-analyzer",
      args: [],
      binaryName: null,
      binaryOnPath: false,
      useNpxFallback: false,
    });
  });

  it("resolves a bare `npx <binary> --stdio` layout", () => {
    const launch = resolveNpxLaunch("npx", ["pyright", "--stdio"], () => "/usr/bin/pyright");
    expect(launch).toMatchObject({
      command: "pyright",
      args: ["--stdio"],
      useNpxFallback: false,
    });
  });
});

describe("extractBinaryFromNpxArgs", () => {
  it("returns null for a tail-arg layout", () => {
    expect(extractBinaryFromNpxArgs(["--package", "x", "srv", "--stdio", "--foo"])).toBeNull();
  });

  it("rejects version-like tokens", () => {
    expect(isPackageVersion("typescript@5")).toBe(true);
    expect(isPackageVersion("pyright")).toBe(false);
  });
});

describe("isOfflineLsp", () => {
  it("reads the flag and treats 0/false/empty as off", () => {
    expect(isOfflineLsp({ MMA_LSP_OFFLINE: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isOfflineLsp({ MMA_LSP_OFFLINE: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isOfflineLsp({ MMA_LSP_OFFLINE: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isOfflineLsp({ MMA_LSP_OFFLINE: "false" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isOfflineLsp({ MMA_LSP_OFFLINE: "" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isOfflineLsp({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("falls back to the config flag when the env var is unset", () => {
    expect(isOfflineLsp({} as NodeJS.ProcessEnv, true)).toBe(true);
    expect(isOfflineLsp({} as NodeJS.ProcessEnv, false)).toBe(false);
  });

  it("lets the env var override the config flag either way", () => {
    expect(isOfflineLsp({ MMA_LSP_OFFLINE: "0" } as NodeJS.ProcessEnv, true)).toBe(false);
    expect(isOfflineLsp({ MMA_LSP_OFFLINE: "1" } as NodeJS.ProcessEnv, false)).toBe(true);
  });
});
