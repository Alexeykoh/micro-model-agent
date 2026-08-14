import { delimiter, join } from "path";
import { existsSync } from "fs";
import { platform } from "os";

const WIN_EXTS = [".cmd", ".bat", ".exe", ".com"];

/**
 * Resolve the command string passed to `child_process.spawn` on Windows.
 *
 * Node's `spawn` cannot execute `.cmd`/`.bat` shims directly without a shell,
 * and a bare `npx` fails with `spawn npx ENOENT` because on Windows the
 * real executable is `npx.cmd`. This returns the first existing shim
 * (`npx.cmd`, `npx.bat`, `npx.exe`, ...) found on PATH, or the bare command
 * when nothing exists (the spawn will then fail with a meaningful ENOENT).
 *
 * Non-Windows platforms and commands that already carry an extension or a
 * path separator are returned unchanged.
 */
export function resolveSpawnCommand(
  command: string,
  platformName: string = platform(),
  pathEnv: string = process.env.PATH ?? "",
): string {
  if (platformName !== "win32") return command;
  // Already a path or has an extension — pass through.
  if (
    command.includes("/") ||
    command.includes("\\") ||
    WIN_EXTS.some((ext) => command.toLowerCase().endsWith(ext))
  ) {
    return command;
  }
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of WIN_EXTS) {
      const candidate = join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return `${command}${ext}`;
    }
  }
  return command;
}

/**
 * Join a resolved command and its args into a single cmd.exe command line.
 *
 * Under Node on Windows, `spawn` of a `.cmd`/`.bat` shim WITHOUT a shell throws
 * `spawn EINVAL` (CreateProcess cannot run batch files directly). Resolving
 * `npx` → `npx.cmd` fixes the old `ENOENT` but not the `EINVAL` — the spawn
 * still has no shell. The reliable fix is to run the whole command line through
 * `cmd.exe /d /s /c` (i.e. `spawn(line, { shell: true })`). This helper builds
 * that line, quoting any argument that contains cmd.exe metacharacters so the
 * package names and flags in LSP configs (`typescript-language-server --stdio`,
 * `pyright --stdio`) survive the round-trip.
 *
 * Non-Windows platforms never call this (they spawn the resolved command +
 * args directly, no shell).
 */
export function buildWinCommandLine(command: string, args: string[]): string {
  const quote = (part: string): string => {
    if (part === "") return '""';
    if (!/[\s"&|^<>()%!]/.test(part)) return part;
    return `"${part.replace(/"/g, '\\"')}"`;
  };
  return [command, ...args].map(quote).join(" ");
}
