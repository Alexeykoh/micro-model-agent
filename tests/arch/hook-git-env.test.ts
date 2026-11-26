import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Гвард к инциденту 2026-10-24: pre-push запускает `bun test` с env хука, и git
 * экспортирует туда `GIT_DIR`/`GIT_WORK_TREE`. Тест `critic-evidence` спавнит
 * `git init/add/commit` во временном каталоге — с унаследованным `GIT_DIR`
 * команды ушли в настоящий репозиторий: `.git/config` стал `bare`, в `master`
 * попал пустой коммит «init». Хук обязан чистить эти переменные до прогона.
 */
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const HOOK = join(REPO_ROOT, ".githooks", "pre-push");

/** Переменные, по которым git находит репозиторий/индекс/объекты. */
const REPO_LOCATING = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

describe("pre-push hook env", () => {
  const hook = readFileSync(HOOK, "utf-8");

  it("scrubs repository-locating GIT_* vars before running the gate", () => {
    const from = hook.indexOf("\nunset ");
    const to = hook.indexOf("\nif ", from);
    const unset = from === -1 ? "" : hook.slice(from, to === -1 ? undefined : to);
    expect(unset).not.toBe("");
    for (const name of REPO_LOCATING) {
      expect(unset, `${name} must be unset in .githooks/pre-push`).toContain(name);
    }
    const unsetAt = hook.indexOf("unset ");
    const gateAt = hook.indexOf("if bun run quality");
    expect(unsetAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(unsetAt);
  });
});
