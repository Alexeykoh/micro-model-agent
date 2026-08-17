import { spawn, execSync, type ChildProcess, type SpawnOptions } from "child_process";
import { resolve } from "path";
import { platform } from "os";
import type { LspDiagnostic, LspServerConfig, PublishDiagnosticsParams } from "./types";
import { resolveSpawnCommand, buildWinCommandLine } from "./command";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

const DEFAULT_TIMEOUT = 15000;

export class LspClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private contentLength = -1;
  private diagnostics: LspDiagnostic[] = [];
  private diagnosticsResolve: ((diags: LspDiagnostic[]) => void) | null = null;
  private diagnosticsTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;

  async checkFile(
    filePath: string,
    baseDir: string,
    config: LspServerConfig,
    projectRoot: string = baseDir,
  ): Promise<LspDiagnostic[]> {
    const timeout = config.timeout ?? DEFAULT_TIMEOUT;

    try {
      await this.initialize(config, projectRoot, timeout);
      this.sendNotification("initialized", {});

      const uri = this.pathToUri(resolve(filePath));
      const fs = await import("fs");
      const content = fs.readFileSync(filePath, "utf-8");

      const diagPromise = new Promise<LspDiagnostic[]>((resolve) => {
        this.diagnosticsResolve = resolve;
        this.diagnostics = [];
        this.diagnosticsTimer = setTimeout(() => {
          this.diagnosticsResolve?.([]);
          this.diagnosticsResolve = null;
        }, timeout);
      });

      this.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: this.languageFromPath(filePath),
          version: 1,
          text: content,
        },
      });

      return await diagPromise;
    } catch (e) {
      // Re-throw so the LspModule can surface failures instead of hiding them.
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      await this.shutdown();
    }
  }

  /**
   * Lightweight "does the server actually start" probe: spawn + initialize +
   * shutdown. Used by the REPL banner to surface a dead server (npx
   * auto-install failure, wrong package name, missing binary) up front instead
   * of the first write_file timing out.
   */
  async probe(config: LspServerConfig, projectRoot: string, timeout: number): Promise<void> {
    try {
      await this.initialize(config, projectRoot, timeout);
    } finally {
      await this.shutdown();
    }
  }

  private async initialize(
    config: LspServerConfig,
    projectRoot: string,
    timeout: number,
  ): Promise<void> {
    await this.startServer(config, projectRoot);

    const rootUri = this.pathToUri(projectRoot);
    const initParams = {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
      capabilities: { textDocument: { publishDiagnostics: {} } },
    };
    try {
      await this.sendRequest("initialize", initParams, timeout);
    } catch (e) {
      // npx auto-install can blow past the initialize timeout on first run — retry once.
      if (!(e instanceof Error) || !e.message.includes("initialize")) throw e;
      await this.shutdown();
      await this.startServer(config, projectRoot);
      await this.sendRequest("initialize", initParams, timeout);
    }
    this.initialized = true;
  }

  private async startServer(config: LspServerConfig, projectRoot: string): Promise<void> {
    if (config.autoInstall === false) {
      try {
        execSync(`where ${config.command}`, { stdio: "pipe", timeout: 3000 });
      } catch {
        throw new Error(`${config.command} not found in PATH`);
      }
    }

    return new Promise((resolve, reject) => {
      const args = config.args ?? [];
      const isWin = platform() === "win32";
      let spawnCommand = resolveSpawnCommand(config.command);
      let spawnArgs = args;
      const spawnOpts: SpawnOptions = {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...config.env },
        cwd: projectRoot,
      };
      if (isWin) {
        // A `.cmd` shim can't be spawned directly under Node (`spawn npx EINVAL`) — run via cmd.exe.
        spawnCommand = buildWinCommandLine(spawnCommand, args);
        spawnArgs = [];
        spawnOpts.shell = true;
      }
      const proc = spawn(spawnCommand, spawnArgs, spawnOpts);

      proc.on("error", reject);

      proc.stdout!.on("data", (chunk: Buffer) => {
        this.handleData(chunk);
      });

      proc.stderr!.on("data", () => {});

      proc.once("spawn", () => {
        resolve();
      });

      this.process = proc;

      setTimeout(() => {
        if (!this.initialized && this.process) reject(new Error("LSP server start timeout"));
      }, config.timeout ?? 10000);
    });
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    this.parseMessages();
  }

  private parseMessages(): void {
    while (true) {
      if (this.contentLength === -1) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const header = this.buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length: (\d+)/i);
        if (!match) {
          this.buffer = this.buffer.slice(headerEnd + 4);
          this.contentLength = -1;
          continue;
        }

        this.contentLength = parseInt(match[1], 10);
        // Guard against malicious/buggy servers sending absurd Content-Length
        if (this.contentLength > 10 * 1024 * 1024) {
          this.buffer = this.buffer.slice(headerEnd + 4);
          this.contentLength = -1;
          continue;
        }
        this.buffer = this.buffer.slice(headerEnd + 4);
      }

      if (this.buffer.length < this.contentLength) return;

      const body = this.buffer.slice(0, this.contentLength);
      this.buffer = this.buffer.slice(this.contentLength);
      this.contentLength = -1;

      try {
        const msg = JSON.parse(body);
        this.handleMessage(msg);
      } catch {}
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as PublishDiagnosticsParams;
      if (params?.diagnostics) {
        this.diagnostics = params.diagnostics;
        if (this.diagnosticsTimer) {
          clearTimeout(this.diagnosticsTimer);
          this.diagnosticsTimer = null;
        }
        this.diagnosticsResolve?.(this.diagnostics);
        this.diagnosticsResolve = null;
      }
      return;
    }

    if (msg.id !== undefined && msg.id !== null) {
      const pending = this.pending.get(msg.id as number);
      if (pending) {
        this.pending.delete(msg.id as number);
        if (msg.error) {
          pending.reject(
            new Error(String((msg.error as Record<string, unknown>).message ?? "LSP error")),
          );
        } else {
          pending.resolve(msg.result);
        }
      }
    }
  }

  private sendRequest(method: string, params: unknown, timeout: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pending.set(id, { resolve, reject });

      const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.write(message);

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP request timeout: ${method}`));
        }
      }, timeout);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const message = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.write(message);
  }

  private write(message: string): void {
    if (!this.process?.stdin?.writable) return;
    const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;
    try {
      this.process.stdin.write(header + message);
    } catch {}
  }

  private async shutdown(): Promise<void> {
    try {
      if (this.process && this.initialized && this.process.stdin?.writable) {
        this.sendRequest("shutdown", null, 3000).catch(() => {});
        this.sendNotification("exit", null);
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch {
    } finally {
      if (this.process) {
        try {
          this.process.kill();
        } catch {}
        this.process = null;
      }
      this.initialized = false;
      this.buffer = "";
      this.contentLength = -1;
      if (this.diagnosticsTimer) {
        clearTimeout(this.diagnosticsTimer);
        this.diagnosticsTimer = null;
      }
    }
  }

  private pathToUri(filePath: string): string {
    const normalized = filePath.replace(/\\/g, "/");
    return /^[a-zA-Z]:/.test(normalized) ? `file:///${normalized}` : `file://${normalized}`;
  }

  private languageFromPath(filePath: string): string {
    const ext = filePath.split(".").pop()?.toLowerCase();
    const map: Record<string, string> = {
      ts: "typescript",
      tsx: "typescriptreact",
      mts: "typescript",
      cts: "typescript",
      js: "javascript",
      jsx: "javascriptreact",
      mjs: "javascript",
      cjs: "javascript",
      py: "python",
      go: "go",
      rs: "rust",
      json: "json",
      html: "html",
      css: "css",
      scss: "scss",
      md: "markdown",
      yaml: "yaml",
      yml: "yaml",
    };
    return map[ext ?? ""] ?? "plaintext";
  }
}
