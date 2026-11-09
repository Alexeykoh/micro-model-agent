import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { dockerAvailable, runDockerBash, DEFAULT_SANDBOX_IMAGE } from "../src/tools/bash-docker";

// Live-интеграция sandbox (P0 изоляция 2/2). Пропускается без daemon и
// без явного флага: на CI (GitHub Windows runner) Docker Desktop file-sharing
// broken — bind-mount падает. Локально: MMA_LIVE_DOCKER=1 bun test tests/bash-docker-live.test.ts
describe.skipIf(!dockerAvailable() || process.env.MMA_LIVE_DOCKER !== "1")("sandbox docker live (cert acceptance)", () => {
  it("mount write inside baseDir is visible on the host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-sandbox-live-"));
    try {
      writeFileSync(join(dir, "probe.txt"), "host\n");
      const res = await runDockerBash({
        command: "echo container-file > /work/from-container.txt && cat /work/from-container.txt",
        workdir: dir,
        baseDir: dir,
        image: DEFAULT_SANDBOX_IMAGE,
      });
      expect(res.success).toBe(true);
      expect(existsSync(join(dir, "from-container.txt"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("write outside the mount fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-sandbox-live-"));
    try {
      const res = await runDockerBash({
        command: "echo escape > /host-escape-marker.txt",
        workdir: dir,
        baseDir: dir,
        image: DEFAULT_SANDBOX_IMAGE,
      });
      expect(res.success).toBe(false);
      expect(existsSync(join(dir, "host-escape-marker.txt"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("egress is denied (connect fails, not success)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-sandbox-live-"));
    try {
      const res = await runDockerBash({
        command: "bun -e \"const r = await fetch('https://example.com'); console.log('NET-OK', r.status);\"",
        workdir: dir,
        baseDir: dir,
        image: DEFAULT_SANDBOX_IMAGE,
      });
      // Успех bash + падение fetch (или сам fetch-error) ≠ NET-OK.
      expect(res.output).not.toContain("NET-OK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
