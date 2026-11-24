import { describe, expect, it } from "vitest";
import { LspConnection } from "../../../src/modules/lsp/connection";
import { FakeLspServer } from "../../helpers/fake-lsp-server";

/** INV-15: протокольная ошибка записи не должна быть неотличима от успеха. */
function makeLogger(): {
  warns: Array<{ msg: string; meta?: Record<string, unknown> }>;
  logger: {
    debug(): void;
    info(): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(): void;
  };
} {
  const warns: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  return {
    warns,
    logger: {
      debug() {},
      info() {},
      warn: (msg, meta) => {
        warns.push({ msg, meta });
      },
      error() {},
    },
  };
}

describe("LSP: счётчик протокольных ошибок записи", () => {
  it("закрывает соединение с причиной в логе после 4 подряд ошибок записи", async () => {
    const server = new FakeLspServer();
    let failing = false;
    let killed = false;
    const proc = {
      get stdin() {
        if (failing) {
          return {
            writable: true,
            write: () => {
              throw new Error("EPIPE");
            },
          };
        }
        return server.stdin;
      },
      stdout: server,
      stderr: server.stderr,
      kill: () => {
        killed = true;
        return true;
      },
      once: (event: "exit", cb: () => void) => {
        server.once(event, cb);
      },
      on: (event: "error", cb: (e: Error) => void) => {
        server.on(event, cb);
      },
    } as never;
    const { warns, logger } = makeLogger();
    const conn = new LspConnection(
      "ts",
      "/tmp/proj",
      { command: "tsserver", args: [] } as never,
      { spawn: async () => proc, logger } as never,
    );
    await conn.open();
    failing = true;
    for (let i = 0; i < 4; i++) {
      conn.syncUri("file:///t.ts", "typescript", `let x = ${i};`);
    }

    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toContain("protocol errors");
    expect(warns[0]?.meta).toMatchObject({ count: 4, cause: "EPIPE" });
    expect(killed).toBe(true);
    expect(conn.isOpen).toBe(false);
  });

  it("сбрасывает счётчик после успешной записи", async () => {
    const server = new FakeLspServer();
    let failing = false;
    let killed = false;
    const proc = {
      get stdin() {
        if (failing) {
          return {
            writable: true,
            write: () => {
              throw new Error("EPIPE");
            },
          };
        }
        return server.stdin;
      },
      stdout: server,
      stderr: server.stderr,
      kill: () => {
        killed = true;
        return true;
      },
      once: (event: "exit", cb: () => void) => {
        server.once(event, cb);
      },
      on: (event: "error", cb: (e: Error) => void) => {
        server.on(event, cb);
      },
    } as never;
    const { warns, logger } = makeLogger();
    const conn = new LspConnection(
      "ts",
      "/tmp/proj",
      { command: "tsserver", args: [] } as never,
      { spawn: async () => proc, logger } as never,
    );
    await conn.open();

    failing = true;
    conn.syncUri("file:///a.ts", "typescript", "let a = 1;");
    conn.syncUri("file:///b.ts", "typescript", "let b = 1;");
    failing = false;
    conn.syncUri("file:///c.ts", "typescript", "let c = 1;");
    failing = true;
    conn.syncUri("file:///d.ts", "typescript", "let d = 1;");
    conn.syncUri("file:///e.ts", "typescript", "let e = 1;");

    expect(warns).toHaveLength(0);
    expect(killed).toBe(false);
  });
});
