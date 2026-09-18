import { spawnSync } from "node:child_process";
import { getDefaultChannel } from "../output";

/**
 * Args that relaunch the current CLI in a fresh process: drop the runtime's
 * argv[0] (the bun/node binary) and keep the entry script plus every user arg.
 */
export function relaunchArgs(argv: string[]): string[] {
  return argv.slice(1);
}

/**
 * Re-exec the current CLI in a brand-new process with inherited stdio, then
 * exit with its status.
 *
 * First-run setup uses this so the wizard and the REPL never share a process:
 * on Bun/Windows the raw-mode `LineEditor` only receives keypresses when it is
 * the FIRST consumer of stdin, and reusing one editor across the
 * wizard → bootstrap → REPL phases leaks prompt/frame state. A fresh process
 * makes the REPL editor the first stdin consumer by construction.
 *
 * `MMA_POST_SETUP=1` is set on the child so a failed config write can never
 * loop the wizard.
 */
export function relaunchCli(): never {
  const args = relaunchArgs(process.argv);
  const entry = args[0];
  if (!entry) process.exit(0);
  const child = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, MMA_POST_SETUP: "1" },
  });
  if (child.error) {
    getDefaultChannel().writeLine(`Failed to relaunch the CLI: ${child.error.message}`, "stderr");
    process.exit(1);
  }
  process.exit(child.status ?? 0);
}
