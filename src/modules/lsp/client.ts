import { spawn, execSync, type ChildProcess, type SpawnOptions } from "child_process";
import { resolve } from "path";
import { platform } from "os";
import type { LspDiagnostic, LspServerConfig, PublishDiagnosticsParams } from "./types";
import { resolveSpawnCommand, buildWinCommandLine } from "./command";
import { killTree } from "../processes/registry";
import { toForwardSlash } from "../../tools/path-utils";
import type { Logger } from "../../logger/app-logger";
import { errMsg } from "../../utils";

/**
 * Logger adapter that writes LSP diagnostics to app.jsonl only — never to
 * console/terminal. LSP warnings are noisy (timeout on first run, npx
 * install) and should be diagnosable from session files without polluting
 * the user's chat.
 */
export class FileOnlyLogger implements LspClientLogger {
  constructor(private logger: Logger) {}
  debug(msg: string, meta?: Record<string, unknown>): void {
    this.logger.logSilent("debug", msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.logger.logSilent("info", msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.logger.logSilent("warn", msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.logger.logSilent("error", msg, meta);
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export interface LspClientLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const DEFAULT_TIMEOUT = 15000;

export class LspClient {
  private logger: LspClientLogger | null = null;

  setLogger(logger: LspClientLogger | null): void {
    this.logger = logger;
  }
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private buffer: Buffer = Buffer.alloc(0);
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
      const msg = errMsg(e);
      this.logger?.warn(`LSP initialize failed (attempt 1): ${msg}`, {
        command: config.command,
        projectRoot,
      });
      // npx auto-install can blow past the initialize timeout on first run — retry once.
      if (!(e instanceof Error) || !e.message.includes("initialize")) throw e;
      await this.shutdown();
      await this.startServer(config, projectRoot);
      try {
        await this.sendRequest("initialize", initParams, timeout);
      } catch (retryErr) {
        const retryMsg = errMsg(retryErr);
        this.logger?.error(`LSP initialize failed (attempt 2, giving up): ${retryMsg}`, {
          command: config.command,
          projectRoot,
        });
        throw retryErr;
      }
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

    // When the command is npx, try to find the actual binary globally first.
    // npx downloads packages on every invocation (slow on Windows, ~8-15s),
    // even when the binary is already installed globally.
    let effectiveCommand = config.command;
    let effectiveArgs = config.args ?? [];
    if (config.command === "npx" && effectiveArgs.length > 0) {
      const binaryName = this.extractBinaryFromNpxArgs(effectiveArgs);
      if (binaryName) {
        const whichCmd = platform() === "win32" ? `where ${binaryName}` : `which ${binaryName}`;
        try {
          execSync(whichCmd, { stdio: "pipe", timeout: 3000 });
          // Binary found globally — use it directly, skip npx.
          effectiveCommand = binaryName;
          effectiveArgs = effectiveArgs.filter(
            (a) => a !== "--yes" && a !== "--package" && a !== binaryName && !this.isPackageVersion(a),
          );
          this.logger?.debug(`LSP: using globally installed ${binaryName} (skipped npx)`);
        } catch {
          // Not found globally — fall back to npx (will auto-install).
          this.logger?.debug(`LSP: ${binaryName} not found globally, falling back to npx`);
        }
      }
    }

    return new Promise((resolve, reject) => {
      const args = effectiveArgs;
      const isWin = platform() === "win32";
      let spawnCommand = resolveSpawnCommand(effectiveCommand);
      let spawnArgs = args;
      const spawnOpts: SpawnOptions = {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...config.env },
        cwd: projectRoot,
        // POSIX: make the child a process-group leader so killTree()'s
        // `kill(-pid)` reaches the whole chain (npx → node → tsserver).
        // Without it the group kill fails with ESRCH and grandchildren
        // survive as orphans. Windows relies on taskkill /T instead.
        detached: !isWin,
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
        if (!this.initialized && this.process) {
          const msg = "LSP server start timeout";
          this.logger?.error(msg, { command: config.command, projectRoot, timeout: config.timeout ?? DEFAULT_TIMEOUT });
          reject(new Error(msg));
        }
      }, config.timeout ?? DEFAULT_TIMEOUT);
    });
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.parseMessages();
  }

  private parseMessages(): void {
    while (true) {
      if (this.contentLength === -1) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        // Headers are ASCII — decode just the header slice.
        const header = this.buffer.subarray(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length: (\d+)/i);
        if (!match) {
          this.buffer = this.buffer.subarray(headerEnd + 4);
          continue;
        }

        this.contentLength = parseInt(match[1], 10);
        // Guard against malicious/buggy servers sending absurd Content-Length
        if (this.contentLength > 10 * 1024 * 1024) {
          this.buffer = this.buffer.subarray(headerEnd + 4);
          this.contentLength = -1;
          continue;
        }
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }

      // Content-Length counts BYTES, not JS characters. Slicing a decoded
      // string by character count corrupts frames containing multi-byte
      // UTF-8 (e.g. Cyrillic diagnostics) — keep the remainder as raw bytes.
      if (this.buffer.length < this.contentLength) return;

      const body = this.buffer.subarray(0, this.contentLength).toString("utf8");
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = -1;

      try {
        const msg = JSON.parse(body);
        this.handleMessage(msg);
      } catch (e) {
        this.logger?.debug(`LSP JSON parse error: ${errMsg(e)}`);
      }
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
          const msg = `LSP request timeout: ${method}`;
          this.logger?.warn(msg, { method, timeout });
          reject(new Error(msg));
        }
      }, timeout);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const message = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.write(message);
  }

  private write(message: string): void {
    if (!this.process?.stdin?.writable) {
      this.logger?.debug("LSP write failed: process stdin not writable");
      return;
    }
    const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;
    try {
      this.process.stdin.write(header + message);
    } catch (e) {
      this.logger?.debug(`LSP write error: ${errMsg(e)}`);
    }
  }

  private async shutdown(): Promise<void> {
    try {
      if (this.process && this.initialized && this.process.stdin?.writable) {
        // Await the shutdown response (with timeout) so the server has time to
        // acknowledge before we send exit and kill the process.  The old code
        // fired shutdown as fire-and-forget, then killed immediately — the
        // server never had a chance to reply, producing spurious timeout warnings.
        try {
          await this.sendRequest("shutdown", null, 3000);
        } catch (e) {
          this.logger?.debug(`LSP shutdown request failed: ${errMsg(e)}`);
        }
        this.sendNotification("exit", null);
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (e) {
      this.logger?.debug(`LSP shutdown error: ${errMsg(e)}`);
    } finally {
      if (this.process) {
        // The direct child on win32 is the cmd.exe wrapper; killing it alone
        // orphans the npx → node → tsserver tree (observed as leaked node
        // processes after every check). Tree-kill so the whole chain dies.
        try {
          killTree(this.process);
        } catch (e) {
          this.logger?.debug(`LSP killTree error: ${errMsg(e)}`);
        }
        this.process = null;
      }
      this.initialized = false;
      this.buffer = Buffer.alloc(0);
      this.contentLength = -1;
      if (this.diagnosticsTimer) {
        clearTimeout(this.diagnosticsTimer);
        this.diagnosticsTimer = null;
      }
    }
  }

  private pathToUri(filePath: string): string {
    const normalized = toForwardSlash(filePath);
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

  /**
   * Extract the actual binary name from npx args — only for the strict layout
   * `[--yes] [--package X]... <binary> --stdio`. Servers with trailing server
   * arguments (e.g. angular's `ngserver --stdio --tsProbeLocations …`) return
   * null and always run through npx, so their flags are never mistaken for the
   * binary or stripped.
   */
  private extractBinaryFromNpxArgs(args: string[]): string | null {
    const stdioIdx = args.lastIndexOf("--stdio");
    if (stdioIdx !== args.length - 1 || stdioIdx < 1) return null;
    const binary = args[stdioIdx - 1];
    if (!binary || binary.startsWith("-") || this.isPackageVersion(binary)) return null;
    for (let i = 0; i < stdioIdx - 1; i++) {
      const a = args[i];
      if (a === "--yes") continue;
      if (a === "--package") {
        i++;
        continue;
      }
      return null;
    }
    return binary;
  }

  /** Check if a string looks like a package version specifier (e.g. "typescript@5"). */
  private isPackageVersion(s: string): boolean {
    return /^[\w-]+@[\d.+*-]/.test(s);
  }
}
