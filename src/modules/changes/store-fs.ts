import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

export function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Atomic private-file replacement; callers serialize writes to the same path. */
export function writePrivateFileAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, content, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
    chmodSync(file, 0o600);
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
