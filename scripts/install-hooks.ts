// Point git at the versioned `.githooks` directory so the pre-push quality gate
// runs locally. Invoked from the `prepare` script (executes on `bun install`).
// No-op outside a git checkout; idempotent.
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const isRepo = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: root, stdio: "ignore" });
if (isRepo.status !== 0) process.exit(0);

const current = spawnSync("git", ["config", "--get", "core.hooksPath"], {
  cwd: root,
  encoding: "utf-8",
});
if ((current.stdout ?? "").trim() === ".githooks") process.exit(0);

const set = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
  cwd: root,
  stdio: "ignore",
});
process.exit(set.status ?? 1);
