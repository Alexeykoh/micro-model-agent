import { spawn, spawnSync, type ChildProcess } from "child_process";
import { platform } from "os";

export type ProcessStatus = "running" | "exited" | "killed";

export interface ManagedProcess {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  sessionId?: string;
  status: ProcessStatus;
  exitCode: number | null;
  startedAt: string;
  log: string[];
  /** Set when the child failed to spawn (bad cwd, missing shell, etc.). */
  spawnError?: string;
}

const MAX_LOG_LINES = 2000;
const MAX_KEPT_PROCESSES = 20;

let seq = 0;

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (platform() === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 3000,
      });
    } catch {
      /* already dead */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

interface ExitWaiter {
  promise: Promise<void>;
  resolve: () => void;
}

class ProcessRegistry {
  private procs = new Map<string, ManagedProcess>();
  private children = new Map<string, ChildProcess>();
  private exitWaiters = new Map<string, ExitWaiter>();

  /**
   * Start a command. The returned entry buffers output and reports status; a
   * call may check `waitForExit(id)` to learn when (if ever) it finishes.
   */
  start(command: string, cwd: string, sessionId?: string): ManagedProcess {
    const id = `proc_${Date.now()}_${++seq}`;
    const entry: ManagedProcess = {
      id,
      pid: 0,
      command,
      cwd,
      sessionId,
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      log: [],
    };
    this.trimOldEntries();
    this.procs.set(id, entry);

    let child: ChildProcess | undefined;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        detached: platform() !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: any) {
      entry.status = "killed";
      entry.spawnError = e?.message || String(e);
      entry.log.push(`[process error] ${entry.spawnError}`);
      return entry;
    }

    this.children.set(id, child);
    entry.pid = child.pid ?? 0;

    // On Windows, children spawned via cmd.exe output in the OEM code page,
    // NOT UTF-8. Detect the active code page via chcp.com; fall back to
    // ibm866 (Russian CP866) when detection fails — still correct for the
    // majority of users, and always better than the UTF-8 default.
    const decoder: TextDecoder =
      platform() === "win32"
        ? (() => {
            try {
              const cpOut = require("child_process")
                .execSync("chcp.com", {
                  encoding: "buffer",
                  timeout: 2000,
                  windowsHide: true,
                })
                .toString("latin1");
              const m = cpOut.match(/(\d+)/);
              if (m) return new TextDecoder("ibm" + m[1]);
            } catch {
              /* ignore */
            }
            return new TextDecoder("ibm866");
          })()
        : new TextDecoder("utf-8");

    let buf = "";
    const pushLine = (line: string) => {
      if (entry.log.length >= MAX_LOG_LINES) {
        entry.log.shift();
      }
      entry.log.push(line);
    };
    const append = (chunk: Buffer) => {
      const decoded = decoder.decode(chunk, { stream: true });
      buf += decoded;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        pushLine(line);
      }
    };
    const flush = () => {
      buf += decoder.decode();
      if (buf) {
        pushLine(buf);
        buf = "";
      }
    };

    const resolveExit = () => {
      this.exitWaiters.get(id)?.resolve();
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    child.on("error", (err) => {
      if (entry.status === "running") {
        entry.status = "killed";
      }
      entry.spawnError = err.message;
      append(Buffer.from(`[process error] ${err.message}`));
      resolveExit();
    });

    child.on("close", (code) => {
      flush();
      if (entry.status === "running") {
        entry.status = "exited";
      }
      entry.exitCode = code;
      this.children.delete(id);
      resolveExit();
    });

    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.exitWaiters.set(id, { promise, resolve });

    return entry;
  }

  list(sessionId?: string): ManagedProcess[] {
    const all = Array.from(this.procs.values());
    if (!sessionId) return all;
    return all.filter((p) => p.sessionId === sessionId);
  }

  get(id: string): ManagedProcess | undefined {
    return this.procs.get(id);
  }

  getLog(id: string, tail?: number): string {
    const entry = this.procs.get(id);
    if (!entry) return "";
    const lines = tail && tail > 0 ? entry.log.slice(-tail) : entry.log;
    return lines.join("\n");
  }

  /** Kill a background process tree. Returns false when not found. */
  kill(id: string): boolean {
    const entry = this.procs.get(id);
    if (!entry) return false;
    if (entry.status === "running") {
      entry.status = "killed";
      const child = this.children.get(id);
      if (child) {
        killTree(child);
      }
    }
    return true;
  }

  /** Kill every managed background process (used on agent shutdown). */
  killAll(sessionId?: string): number {
    const targets = this.list(sessionId);
    for (const entry of targets) {
      this.kill(entry.id);
    }
    return targets.length;
  }

  /**
   * Resolve `true` when the process exits (or fails to spawn) within
   * `timeoutMs`, otherwise `false` (still running → a background process).
   */
  waitForExit(id: string, timeoutMs: number): Promise<boolean> {
    const entry = this.procs.get(id);
    const waiter = this.exitWaiters.get(id);
    if (!entry || entry.status !== "running" || !waiter) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      waiter.promise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * Remove a finished entry (foreground results do not linger). A still-running
   * entry is killed first so nothing is orphaned.
   */
  remove(id: string): boolean {
    const entry = this.procs.get(id);
    if (!entry) return false;
    if (entry.status === "running") {
      const child = this.children.get(id);
      if (child) {
        killTree(child);
      }
      entry.status = "killed";
    }
    this.procs.delete(id);
    this.children.delete(id);
    this.exitWaiters.delete(id);
    return true;
  }

  private trimOldEntries(): void {
    if (this.procs.size < MAX_KEPT_PROCESSES) return;
    const sorted = Array.from(this.procs.values()).sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt),
    );
    const toRemove = sorted.slice(0, sorted.length - MAX_KEPT_PROCESSES + 1);
    for (const entry of toRemove) {
      this.remove(entry.id);
    }
  }
}

export const processRegistry = new ProcessRegistry();
