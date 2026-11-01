import { describe, it, expect, vi } from "vitest";
import { LspClient } from "../../../src/modules/lsp/client";
import type { LspConnectionPool } from "../../../src/modules/lsp/pool";
import type { LspServerConfig } from "../../../src/modules/lsp/types";

/** Минимальный пул: считает dispose и запрещает acquire после dispose. */
function makePool(onDispose: () => void) {
  let disposed = false;
  const connection = {
    key: "fake",
    syncUri: vi.fn(),
    diagnosticsFor: vi.fn(async () => []),
  };
  return {
    stats: () => ({ live: 0, restarts: 0, reaped: 0 }),
    keyStates: () => [],
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      onDispose();
    },
    acquire: async () => {
      if (disposed) throw new Error("LSP pool disposed");
      return connection;
    },
    connection,
  };
}

const config = { command: "fake-lsp", args: [], timeout: 1000 } as LspServerConfig;

describe("LspClient: recovery after close", () => {
  it("creates a fresh pool after close and serves the next check", async () => {
    let created = 0;
    let disposed = 0;
    const client = new LspClient({
      poolFactory: () => {
        created++;
        return makePool(() => disposed++) as unknown as LspConnectionPool;
      },
    });

    // Первый пул создаётся лениво при первом обращении.
    expect(client.stats().live).toBe(0);
    expect(created).toBe(1);

    await client.close();
    expect(disposed).toBe(1);

    // После close пул пересоздаётся, а не остаётся disposed.
    expect(client.stats().live).toBe(0);
    expect(created).toBe(2);
    const result = await client.checkFile("/tmp/nonexistent.ts", "/tmp", config, "/tmp");
    expect(result.diagnostics).toEqual([]);
  });

  it("is idempotent: the second close does not dispose twice or create a pool", async () => {
    let created = 0;
    let disposed = 0;
    const client = new LspClient({
      poolFactory: () => {
        created++;
        return makePool(() => disposed++) as unknown as LspConnectionPool;
      },
    });
    expect(client.stats().live).toBe(0);
    await client.close();
    await client.close();
    expect(disposed).toBe(1);
    expect(created).toBe(1);
  });
});
