// Стартовая уборка `~/.mma/versions`: при обновлении на Windows каталог
// работающей версии занят `runtime/bun.exe`, поэтому мусор удаляется только на
// следующем запуске. Уборка не должна касаться dev-чекаута и активной версии.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdater } from "../src/modules/updater/factory";
import type { UpdaterConfig } from "../src/config/types";

const roots: string[] = [];
const cfg = (): UpdaterConfig => ({ enabled: true, autoInstall: false, intervalMs: 0 });

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mma-prune-"));
  roots.push(root);
  return root;
}

/** Ставит min-раскладку install-root: `current` → `versions/active`. */
async function installedLayout(root: string): Promise<string> {
  await mkdir(join(root, "versions", "0.1.0"), { recursive: true });
  await mkdir(join(root, "versions", "0.2.0"), { recursive: true });
  await mkdir(join(root, "versions", "0.2.0", "app"), { recursive: true });
  const entry = join(root, "versions", "0.2.0", "app", "main.js");
  await writeFile(entry, "// fixture\n");
  await symlink(
    join(root, "versions", "0.2.0"),
    join(root, "current"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return entry;
}

async function waitForGone(path: string, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (!existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`still present: ${path}`);
}

const offline = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

describe("startup prune of stale versions", () => {
  it("removes garbage but keeps the active version", async () => {
    const root = await newRoot();
    const entry = await installedLayout(root);

    const mod = createUpdater({
      config: cfg(),
      entryPath: entry,
      deps: { installRoot: root, fetchImpl: offline },
    });
    expect(mod).not.toBeUndefined();
    await waitForGone(join(root, "versions", "0.1.0"));
    expect(existsSync(join(root, "versions", "0.2.0"))).toBe(true);
    mod!.stop();
  });

  it("never touches a checkout layout outside the install root", async () => {
    const root = await newRoot();
    await mkdir(join(root, "versions", "0.1.0"), { recursive: true });
    const checkout = await mkdtemp(join(tmpdir(), "mma-checkout-"));
    roots.push(checkout);

    const mod = createUpdater({
      config: cfg(),
      // Код запущен из чекаута, а install-root — пользовательский `~/.mma`:
      // чистить его из dev-прогона нельзя.
      entryPath: join(checkout, "dist", "main.js"),
      deps: { installRoot: root, fetchImpl: offline },
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(existsSync(join(root, "versions", "0.1.0"))).toBe(true);
    mod!.stop();
  });
});
