// Кроссплатформенный килл дерева процессов, неблокирующий (без stall event loop).
import { spawn } from "child_process";
import { platform } from "os";

/** Минимум, который нужен `killTree` от убиваемого объекта. */
export interface KillableProcess {
  pid?: number | undefined;
  kill(signal?: unknown): boolean;
}

/**
 * Процесс нечем убивать: нет ни pid, ни `kill()`. Вызывающий обязан это
 * залогировать, а не молчать (аудит §8.1).
 */
export class KillTreeUnavailableError extends Error {
  constructor() {
    super("killTree: process has neither pid nor kill()");
    this.name = "KillTreeUnavailableError";
  }
}

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
      /* уже мёртв / нет taskkill */
    }
  });
}

/**
 * Убивает дерево спавненного процесса — кроссплатформенно, неблокирующе.
 *
 * Windows: два прохода `taskkill /T /F` с паузой 150мс (второй добирает детей,
 * ещё создававшихся во время первого обхода дерева, напр. `cmd → node →
 * tsserver`). Оба АСИНХРОННЫ: прежние `spawnSync` + `Atomics.wait` стопили
 * event loop (фроз UI/стрима) до ~10с на процесс при шатдауне.
 *
 * POSIX: килл группы (`-pid`), при неудаче — `SIGKILL` прямому ребёнку
 * (напр. не-detached процесс).
 */
export function killTree(child: KillableProcess): void {
  const pid = child.pid;
  if (!pid) {
    // Без pid дерева нет — бьём хотя бы сам процесс, а если и kill() нет,
    // сообщаем об этом явно (аудит §8.1).
    if (typeof child.kill === "function") {
      child.kill();
      return;
    }
    throw new KillTreeUnavailableError();
  }
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
      /* уже мёртв */
    }
  }
}
