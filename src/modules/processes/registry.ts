import { spawn, spawnSync, type ChildProcess } from "child_process";
import { platform } from "os";
import { killTree } from "./kill-tree";

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
/** Cap a single not-yet-terminated line so a newline-less dump cannot OOM. */
const MAX_PARTIAL_CHARS = 64 * 1024;
const MAX_PARTIAL_BYTES = 64 * 1024;
const MAX_KEPT_PROCESSES = 20;

let seq = 0;

/** OEM decoder (Russian CP866 / active code page) — cached after first use. */
let oemDecoder: TextDecoder | null | undefined;

function getOemDecoder(): TextDecoder | null {
  if (oemDecoder !== undefined) return oemDecoder;
  oemDecoder = null;
  try {
    const cpOut = spawnSync("chcp.com", {
      encoding: "buffer",
      timeout: 2000,
      windowsHide: true,
    }).stdout;
    const m = cpOut ? cpOut.toString("latin1").match(/(\d+)/) : null;
    if (m) {
      try {
        oemDecoder = new TextDecoder("ibm" + m[1]);
      } catch {
        oemDecoder = null;
      }
    }
  } catch {
    /* ignore */
  }
  if (!oemDecoder) {
    try {
      oemDecoder = new TextDecoder("ibm866");
    } catch {
      oemDecoder = null;
    }
  }
  return oemDecoder;
}

/**
 * Decode one complete line of output to UTF-8.
 *
 * Modern tools (Bun, Node, npm, git) write UTF-8 into the pipe regardless of
 * the console code page, while built-in cmd.exe commands (echo, type, dir)
 * emit the OEM code page (CP866 on Russian Windows). Try strict UTF-8 first;
 * fall back to the OEM decoder when the bytes are not valid UTF-8.
 */
function decodeLineToUtf8(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    /* not valid UTF-8 → OEM code page output */
  }
  const oem = getOemDecoder();
  if (oem) {
    try {
      return oem.decode(buf);
    } catch {
      /* unknown encoding — latin1 fallback */
    }
  }
  return buf.toString("latin1");
}

export { killTree } from "./kill-tree";

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

    let buf = "";
    let byteBuf = Buffer.alloc(0);
    const isWin = platform() === "win32";
    const unixDecoder = new TextDecoder("utf-8");
    const pushLine = (line: string) => {
      if (entry.log.length >= MAX_LOG_LINES) {
        entry.log.shift();
      }
      entry.log.push(line);
    };
    const append = (chunk: Buffer) => {
      if (!isWin) {
        const decoded = unixDecoder.decode(chunk, { stream: true });
        buf += decoded;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          pushLine(line);
        }
        // Flush a very long partial line instead of buffering it unboundedly.
        if (buf.length > MAX_PARTIAL_CHARS) {
          pushLine(buf);
          buf = "";
        }
        return;
      }
      // Windows: buffer raw bytes and decode per line. Modern tools (Bun, Node,
      // npm, git) write UTF-8 into the pipe regardless of the console code
      // page; cmd.exe builtins (echo, type, dir) emit the OEM code page. Pick
      // the right decoding per line so Russian text survives either way.
      byteBuf = byteBuf.length ? Buffer.concat([byteBuf, chunk]) : Buffer.from(chunk);
      let nl: number;
      while ((nl = byteBuf.indexOf(0x0a)) !== -1) {
        const raw = byteBuf.subarray(0, nl);
        byteBuf = byteBuf.subarray(nl + 1);
        pushLine(decodeLineToUtf8(raw).replace(/\r$/, ""));
      }
      // Flush a very long partial line instead of buffering it unboundedly.
      if (byteBuf.length > MAX_PARTIAL_BYTES) {
        pushLine(decodeLineToUtf8(byteBuf));
        byteBuf = Buffer.alloc(0);
      }
    };
    const flush = () => {
      if (!isWin) {
        buf += unixDecoder.decode();
        if (buf) {
          pushLine(buf);
          buf = "";
        }
        return;
      }
      if (byteBuf.length) {
        pushLine(decodeLineToUtf8(byteBuf));
        byteBuf = Buffer.alloc(0);
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
      // Write directly to the log, not through `append`: a failed spawn often
      // never emits `close`, so the buffered line would never be flushed and
      // the log would be empty (observed: "records a spawn error" test).
      pushLine(`[process error] ${err.message}`);
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
