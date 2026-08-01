import { spawn, type ChildProcess } from "child_process";
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
}

const MAX_LOG_LINES = 300;
const MAX_KEPT_PROCESSES = 20;

let seq = 0;

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (platform() === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
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

class ProcessRegistry {
  private procs = new Map<string, ManagedProcess>();
  private children = new Map<string, ChildProcess>();

  /**
   * Start a background process. Returns immediately with the entry; output is
   * buffered into `entry.log` as it arrives.
   */
  start(
    command: string,
    cwd: string,
    sessionId?: string,
  ): ManagedProcess {
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

    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: platform() !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.set(id, child);
    entry.pid = child.pid ?? 0;

    let partial = "";
    const append = (chunk: Buffer) => {
      const text = partial + chunk.toString();
      const lines = text.split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (entry.log.length >= MAX_LOG_LINES) {
          entry.log.shift();
        }
        entry.log.push(line);
      }
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    child.on("error", (err) => {
      if (entry.status === "running") {
        entry.status = "killed";
      }
      append(Buffer.from(`[process error] ${err.message}`));
    });

    child.on("close", (code) => {
      if (entry.status === "running") {
        entry.status = "exited";
      }
      entry.exitCode = code;
      this.children.delete(id);
      if (partial) {
        entry.log.push(partial);
        partial = "";
      }
    });

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

  private trimOldEntries(): void {
    if (this.procs.size < MAX_KEPT_PROCESSES) return;
    const sorted = Array.from(this.procs.values()).sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt),
    );
    const toRemove = sorted.slice(0, sorted.length - MAX_KEPT_PROCESSES + 1);
    for (const entry of toRemove) {
      this.procs.delete(entry.id);
      this.children.delete(entry.id);
    }
  }
}

export const processRegistry = new ProcessRegistry();
