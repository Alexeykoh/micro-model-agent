import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDomainFiles } from "../../src/config/domains";
import { mergeSecurityConfig } from "../../src/config/security";
import {
  isTrustedHost,
  providerHost,
} from "../../src/modules/security/data-policy/egress-provider";

const root = join(import.meta.dir, "../..");
const seedPath = (name: string) => join(root, "deploy/docker-test/seed", name);
const readSeed = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(seedPath(name), "utf8")) as Record<string, unknown>;

describe("docker-test seed: локальный провайдер доверенный", () => {
  it("security.json объявляет host.docker.internal в trustedHosts", () => {
    const security = readSeed("security.json") as {
      security: { dataPolicy: { trustedHosts: string[] } };
    };
    expect(security.security.dataPolicy.trustedHosts).toContain("host.docker.internal");
  });

  it("хост provider.json покрыт trustedHosts из security.json", () => {
    const provider = readSeed("provider.json") as { provider: { baseUrl: string } };
    const security = readSeed("security.json") as {
      security: { dataPolicy: { trustedHosts: string[] } };
    };
    const host = providerHost(provider.provider.baseUrl);
    expect(host).toBe("host.docker.internal");
    expect(isTrustedHost(host ?? "", security.security.dataPolicy.trustedHosts)).toBe(true);
  });

  it("entrypoint сидит security.json в config volume", () => {
    const entrypoint = readFileSync(join(root, "deploy/docker-test/entrypoint.sh"), "utf8");
    expect(entrypoint).toContain("seed/security.json");
    expect(entrypoint).toContain("/config/config/security.json");
  });

  it("seed загружается как домен security и сохраняет дефолты", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-docker-seed-"));
    try {
      mkdirSync(join(dir, "config"), { recursive: true });
      copyFileSync(seedPath("security.json"), join(dir, "config", "security.json"));
      const partial = loadDomainFiles(dir) as {
        security?: Parameters<typeof mergeSecurityConfig>[0];
      };
      expect(partial.security).toBeDefined();

      const merged = mergeSecurityConfig(partial.security);
      expect(merged.dataPolicy.trustedHosts).toContain("host.docker.internal");
      expect(merged.bash.enabled).toBe(true);
      expect(merged.paths.enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
