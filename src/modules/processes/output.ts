// Output decoding + line splitting for managed processes. Extracted from
// `registry.ts` (rule 6): Windows consoles speak OEM codepages while Bun/Node/
// git tools speak UTF-8, and a partial line must not grow unbounded while a
// chatty process never emits a newline.
import { spawnSync } from "child_process";
import { platform } from "os";

/** One line kept in the ring buffer while a process keeps typing. */
export const MAX_PARTIAL_CHARS = 64 * 1024;
export const MAX_PARTIAL_BYTES = 64 * 1024;

/** OEM decoder (codepage CP866 / Cyrillic consoles) - chosen once per process. */
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
 * Decodes a raw line as UTF-8 first, then falls back to the OEM codepage.
 * Modern tools (Bun, Node, npm, git) emit UTF-8 even on a Cyrillic console;
 * cmd.exe builtins (echo, type, dir) emit the console codepage.
 */
export function decodeLineToUtf8(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    /* not UTF-8 → try the OEM decoder */
  }
  const oem = getOemDecoder();
  if (oem) {
    try {
      return oem.decode(buf);
    } catch {
      /* unsupported encoding - fall through to latin1 */
    }
  }
  return buf.toString("latin1");
}

export interface LineSink {
  append(chunk: Buffer): void;
  flush(): void;
}

/**
 * Builds the per-process line splitter. `pushLine` receives complete lines (no
 * trailing newline); `flush` drains a partial tail on exit.
 */
export function createLineSink(pushLine: (line: string) => void): LineSink {
  let buf = "";
  let byteBuf = Buffer.alloc(0);
  const isWin = platform() === "win32";
  const unixDecoder = new TextDecoder("utf-8");

  return {
    append(chunk: Buffer): void {
      if (!isWin) {
        buf += unixDecoder.decode(chunk, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) pushLine(line);
        // Bound a partial line that never ends with a newline.
        if (buf.length > MAX_PARTIAL_CHARS) {
          pushLine(buf);
          buf = "";
        }
        return;
      }
      // Windows: split on raw bytes first so multi-byte characters are never
      // cut in half before decoding.
      byteBuf = byteBuf.length ? Buffer.concat([byteBuf, chunk]) : Buffer.from(chunk);
      let nl: number;
      while ((nl = byteBuf.indexOf(0x0a)) !== -1) {
        const raw = byteBuf.subarray(0, nl);
        byteBuf = byteBuf.subarray(nl + 1);
        pushLine(decodeLineToUtf8(raw).replace(/\r$/, ""));
      }
      if (byteBuf.length > MAX_PARTIAL_BYTES) {
        pushLine(decodeLineToUtf8(byteBuf));
        byteBuf = Buffer.alloc(0);
      }
    },
    flush(): void {
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
    },
  };
}
