import { spawnSync, type ChildProcess } from "child_process";
import { platform } from "os";

/** Synchronous pause without blocking the event loop (via Atomics.wait). */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* ignore */
  }
}

function taskkillPid(pid: number): void {
  try {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 5000,
    });
  } catch {
    /* already dead */
  }
}

/**
 * Kill a spawned process tree — cross-platform.
 *
 * Windows: double `taskkill /T /F` with a 150ms settle gap. The second pass
 * catches late-attaching children that were still being created during the
 * first tree walk (e.g. `cmd.exe → node → tsserver` chains where node is
 * still starting up when cmd is killed).
 *
 * POSIX: process-group kill (`-pid`). Falls back to `SIGKILL` on the direct
 * child when the group kill fails (e.g. non-detached process).
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (platform() === "win32") {
    taskkillPid(pid);
    sleepSync(150);
    taskkillPid(pid);
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
