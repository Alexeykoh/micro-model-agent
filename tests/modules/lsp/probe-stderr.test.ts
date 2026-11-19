import { describe, expect, it } from "vitest";
import { FakeLspServer, spawnOf } from "../../helpers/fake-lsp-server";
import { LspClient, type LspProbeError } from "../../../src/modules/lsp/client";
import type { LspServerConfig } from "../../../src/modules/lsp/types";

/**
 * Проба должна приносить хвост stderr упавшего сервера. Иначе крах на старте
 * (`SyntaxError` от несовместимого Node) виден только в debug-логе, а
 * `/lsp doctor` пишет общий «server error».
 */

const ROOT = "/repo";
const SERVER: LspServerConfig = { command: "fake", args: ["--stdio"], timeout: 40 };
const STDERR_LINE = "SyntaxError: Unexpected token '?'";

function serverThatNeverInitialises(): FakeLspServer {
  return new FakeLspServer({ ignore: ["initialize"] });
}

describe("LspClient.probe", () => {
  it("attaches the crashed server's stderr tail to the error", async () => {
    const server = serverThatNeverInitialises();
    const spawn = spawnOf(server);
    const client = new LspClient({
      spawn: async (plan, cwd) => {
        const proc = await spawn(plan, cwd);
        // Сервер «печатает» причину краха до ответа на initialize.
        server.stderr.write(`${STDERR_LINE}\n    at wrapSafe (node:internal/modules/cjs/loader)\n`);
        return proc;
      },
      resolveLaunch: (config) => ({ command: config.command, args: config.args ?? [] }),
    });

    const error = (await client.probe(SERVER, ROOT, 40).catch((e: unknown) => e)) as LspProbeError;

    expect(error).toBeInstanceOf(Error);
    expect(error.stderrTail).toContain(STDERR_LINE);
    await client.close();
  });

  it("returns without a stderr tail when the server starts", async () => {
    const server = new FakeLspServer();
    const client = new LspClient({
      spawn: spawnOf(server),
      resolveLaunch: (config) => ({ command: config.command, args: config.args ?? [] }),
    });

    await expect(client.probe(SERVER, ROOT, 2000)).resolves.toBeUndefined();
    await client.close();
  });
});
