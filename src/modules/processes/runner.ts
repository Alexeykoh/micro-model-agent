import { spawn } from "child_process";
import { platform } from "os";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface RunCommandOptions {
  cwd?: string;
  callId?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

interface ActiveChild {
  kill: () => void;
}

const activeChildren = new Map<string, ActiveChild>();

/**
 * Kill a foreground command previously registered by `callId` (used by the
 * tool executor when the execution timeout fires). Returns true when a child
 * was found and killed.
 */
export function killByCallId(callId: string): boolean {
  const entry = activeChildren.get(callId);
  if (!entry) return false;
  activeChildren.delete(callId);
  try {
    entry.kill();
  } catch {
    /* already dead */
  }
  return true;
}

function killTree(child: import("child_process").ChildProcess): void {
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
    // `detached: true` makes the child a process-group leader on POSIX,
    // so killing -pid terminates the whole tree.
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

/**
 * Run a shell command asynchronously (non-blocking event loop) and collect
 * stdout/stderr. The child is killed on timeout and can be killed externally
 * via `killByCallId` (used by the tool executor timeout).
 */
export function runCommand(
  command: string,
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const {
    cwd,
    callId,
    timeoutMs = 120_000,
    maxBuffer = 10 * 1024 * 1024,
  } = options;

  return new Promise((resolve) => {
    let timedOut = false;
    let stdout = "";
    let stderr = "";

    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: platform() !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const append = (ref: { value: string }, chunk: Buffer) => {
      const text = chunk.toString();
      const next = ref.value.length + text.length;
      if (next > maxBuffer) {
        ref.value =
          ref.value.slice(ref.value.length + text.length - maxBuffer) + text;
      } else {
        ref.value = ref.value + text;
      }
    };

    const stdoutRef = { value: stdout };
    const stderrRef = { value: stderr };
    child.stdout?.on("data", (chunk: Buffer) => append(stdoutRef, chunk));
    child.stderr?.on("data", (chunk: Buffer) => append(stderrRef, chunk));

    const entry: ActiveChild = {
      kill: () => killTree(child),
    };
    if (callId) {
      activeChildren.set(callId, entry);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.on("error", () => {
      clearTimeout(timer);
      if (callId) activeChildren.delete(callId);
      resolve({
        stdout: stdoutRef.value,
        stderr: stderrRef.value,
        code: null,
        signal: null,
        timedOut,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (callId) activeChildren.delete(callId);
      resolve({ stdout: stdoutRef.value, stderr: stderrRef.value, code, signal, timedOut });
    });
  });
}
