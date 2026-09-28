// Реестр фоновых процессов: спавн, буферизация лога, килл, ожидание выхода.
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { platform } from "os";
import { killTree } from "./kill-tree";

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
/** Кап одной незавершённой строки, чтобы дамп без переводов не дал OOM. */
const MAX_PARTIAL_CHARS = 64 * 1024;
const MAX_PARTIAL_BYTES = 64 * 1024;
const MAX_KEPT_PROCESSES = 20;

let seq = 0;

/** OEM-декодер (русская CP866 / активная кодовая страница) — кеш после первого вызова. */
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
        oemDecoder = new TextDecoder(`ibm${m[1]}`);
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
 * Декодирует одну готовую строку вывода в UTF-8.
 *
 * Современные тулы (Bun, Node, npm, git) пишут UTF-8 в пайп независимо от
 * кодовой страницы консоли, а встроенные команды cmd.exe (echo, type, dir) —
 * OEM-страницу (CP866 на русской Windows). Сначала строгий UTF-8; если байты
 * невалидны — откат на OEM-декодер.
 */
function decodeLineToUtf8(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    /* невалидный UTF-8 → вывод в OEM-кодировке */
  }
  const oem = getOemDecoder();
  if (oem) {
    try {
      return oem.decode(buf);
    } catch {
      /* неизвестная кодировка — откат на latin1 */
    }
  }
  return buf.toString("latin1");
}

/** Реэкспорт килла дерева для потребителей реестра. */
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
   * Запускает команду. Возвращённая запись буферизует вывод и отдаёт статус;
   * дождаться завершения можно через `waitForExit(id)`.
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
        // Сбрасываем очень длинную частичную строку вместо безлимитной буферизации.
        if (buf.length > MAX_PARTIAL_CHARS) {
          pushLine(buf);
          buf = "";
        }
        return;
      }
      // Windows: копим сырые байты и декодируем построчно. Современные тулы
      // (Bun, Node, npm, git) пишут UTF-8 в пайп независимо от кодовой страницы
      // консоли; встроенные команды cmd.exe (echo, type, dir) — OEM-страницу.
      // Декодировка подбирается построчно, чтобы русский выживал в обоих случаях.
      byteBuf = byteBuf.length ? Buffer.concat([byteBuf, chunk]) : Buffer.from(chunk);
      let nl: number;
      while ((nl = byteBuf.indexOf(0x0a)) !== -1) {
        const raw = byteBuf.subarray(0, nl);
        byteBuf = byteBuf.subarray(nl + 1);
        pushLine(decodeLineToUtf8(raw).replace(/\r$/, ""));
      }
      // Сбрасываем очень длинную частичную строку вместо безлимитной буферизации.
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
      // Пишем прямо в лог, не через `append`: упавший спавн часто вообще
      // не эмитит `close`, и буферизованная строка не сбросилась бы —
      // лог остался бы пустым (видно в тесте "records a spawn error").
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

  /** Список процессов, опционально по сессии. */
  list(sessionId?: string): ManagedProcess[] {
    const all = Array.from(this.procs.values());
    if (!sessionId) return all;
    return all.filter((p) => p.sessionId === sessionId);
  }

  /** Процесс по id; undefined, если нет. */
  get(id: string): ManagedProcess | undefined {
    return this.procs.get(id);
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
