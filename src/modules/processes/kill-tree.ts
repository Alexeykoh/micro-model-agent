import { spawn, type ChildProcess } from "child_process";
import { platform } from "os";

/** Fire a `taskkill /T /F` and resolve when it exits (never rejects). */
function taskkillPid(pid: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    } catch {
      /* already dead / taskkill missing */
    }
  });
}

/**
 * Kill a spawned process tree — cross-platform, non-blocking.
 *
 * Windows: two `taskkill /T /F` passes 150ms apart (the second catches children
 * that were still being created during the first tree walk, e.g.
 * `cmd → node → tsserver`). Both are ASYNC: the previous `spawnSync` +
 * `Atomics.wait` stalled the event loop (UI/streaming froze) for up to ~10s per
 * process on shutdown.
 *
 * POSIX: process-group kill (`-pid`), falling back to `SIGKILL` on the direct
 * child when the group kill fails (e.g. non-detached process).
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (platform() === "win32") {
    void taskkillPid(pid).then(() => {
      setTimeout(() => void taskkillPid(pid), 150);
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
