import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  fchmodSync,
} from "node:fs";
import { dirname } from "node:path";

export function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function appendPrivateFile(file: string, content: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(file, "a", 0o600);
    fchmodSync(fd, 0o600);
    appendFileSync(fd, content, { encoding: "utf8" });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fsyncParentDirectory(dir: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Atomic private-file replacement; callers serialize writes to the same path. */
export function writePrivateFileAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
    fsyncParentDirectory(dirname(file));
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write/rename error.
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Preserve the original write/rename error if cleanup is also blocked.
    }
    throw error;
  }
}
