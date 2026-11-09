// Реестр фоновых процессов: спавн, буферизация лога, килл, ожидание выхода.
import { spawn, type ChildProcess } from "child_process";
import { platform } from "os";
import { killTree } from "./kill-tree";
import { findRunning } from "./dedupe";
import { createLineSink } from "./output";

/** Статус управляемого процесса. */
export type ProcessStatus = "running" | "exited" | "killed";

/** Управляемый процесс: метаданные, статус и буфер лога. */
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
  /** Ставится, когда ребёнок не спавнится (битый cwd, нет шелла и т.п.). */
  spawnError?: string;
}

const MAX_LOG_LINES = 2000;
const MAX_KEPT_PROCESSES = 20;

let seq = 0;

/** Реэкспорт килла дерева для потребителей реестра. */
export { killTree, type KillableProcess } from "./kill-tree";

interface ExitWaiter {
  promise: Promise<void>;
  resolve: () => void;
}

class ProcessRegistry {
  private procs = new Map<string, ManagedProcess>();
  private children = new Map<string, ChildProcess>();
  private exitWaiters = new Map<string, ExitWaiter>();

  /**
   * Запускает команду. Возвращённая запись буферизует вывод и отдаёт статус;
   * дождаться завершения можно через `waitForExit(id)`.
   *
   * Дедуп: если та же команда (нормализованные command+cwd) уже бежит в этой
   * сессии — возвращаем существующий процесс без дубля (если не `force`).
   */
  start(
    command: string,
    cwd: string,
    sessionId?: string,
    opts?: { force?: boolean },
  ): ManagedProcess {
    if (!opts?.force) {
      const existing = findRunning(this.procs.values(), command, cwd, sessionId);
      if (existing) return existing;
    }
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
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      entry.status = "killed";
      entry.spawnError = message;
      entry.log.push(`[process error] ${entry.spawnError}`);
      return entry;
    }

    this.children.set(id, child);
    entry.pid = child.pid ?? 0;

    const pushLine = (line: string) => {
      if (entry.log.length >= MAX_LOG_LINES) {
        entry.log.shift();
      }
      entry.log.push(line);
    };
    const sink = createLineSink(pushLine);

    const resolveExit = () => {
      this.exitWaiters.get(id)?.resolve();
    };

    child.stdout?.on("data", sink.append);
    child.stderr?.on("data", sink.append);

    child.on("error", (err) => {
      if (entry.status === "running") {
        entry.status = "killed";
      }
      entry.spawnError = err.message;
      // Пишем прямо в лог, не через `append`: упавший спавн часто вообще
      // не эмитит `close`, и буферизованная строка не сбросилась бы —
      // лог остался бы пустым (видно в тесте "records a spawn error").
      pushLine(`[process error] ${err.message}`);
      resolveExit();
    });

    child.on("close", (code) => {
      sink.flush();
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

  /** Список процессов, опционально по сессии. */
  list(sessionId?: string): ManagedProcess[] {
    const all = Array.from(this.procs.values());
    if (!sessionId) return all;
    return all.filter((p) => p.sessionId === sessionId);
  }

  /**
   * Процесс по id; при заданном `sessionId` — только из своей сессии (§4.9).
   */
  get(id: string, sessionId?: string): ManagedProcess | undefined {
    const entry = this.procs.get(id);
    if (!entry) return undefined;
    if (sessionId !== undefined && entry.sessionId !== sessionId) return undefined;
    return entry;
  }

  /** Лог процесса целиком или хвостом `tail` строк. */
  getLog(id: string, tail?: number): string {
    const entry = this.procs.get(id);
    if (!entry) return "";
    const lines = tail && tail > 0 ? entry.log.slice(-tail) : entry.log;
    return lines.join("\n");
  }

  /** Убивает дерево фонового процесса. False, если не найден. */
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

  /** Убивает все управляемые фоновые процессы (при останове агента). Возвращает число. */
  killAll(sessionId?: string): number {
    const targets = this.list(sessionId);
    for (const entry of targets) {
      this.kill(entry.id);
    }
    return targets.length;
  }

  /**
   * Резолвит `true`, если процесс вышел (или не спавнился) за `timeoutMs`,
   * иначе `false` (всё ещё бежит → фоновый процесс).
   */
  waitForExit(id: string, timeoutMs: number): Promise<boolean> {
    const entry = this.procs.get(id);
    const waiter = this.exitWaiters.get(id);
    if (entry?.status !== "running" || !waiter) {
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
   * Удаляет завершённую запись (foreground-результаты не залеживаются).
   * Ещё бегущая сначала убивается, чтобы не осиротеть.
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

/** Синглтон реестра фоновых процессов. */
export const processRegistry = new ProcessRegistry();
