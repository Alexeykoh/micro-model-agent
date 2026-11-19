// Детект базовой ветки по reflog (чип `⎇ main → dev → feat` в футере).
//
// Реальный git во временном репозитории: сценарии совпадают с тем, как
// создаются ветки на практике — `git branch feat dev` (явная база) и
// `git checkout -b` (Creating from HEAD — база из reflog HEAD).
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  baseChain,
  directBase,
  normalizeRef,
  parseCheckoutFrom,
  parseCreatedFrom,
} from "../../../src/modules/webui/git/base-branch";

const tmpRoots: string[] = [];

function gitIn(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-git-base-"));
  tmpRoots.push(dir);
  gitIn(dir, ["init", "-q", "-b", "main"]);
  gitIn(dir, ["config", "user.email", "t@example.com"]);
  gitIn(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  gitIn(dir, ["add", "a.txt"]);
  gitIn(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

describe("base-branch parsers", () => {
  it("normalizeRef strips refs/ and revision suffixes", () => {
    expect(normalizeRef("refs/heads/main")).toBe("main");
    expect(normalizeRef(" refs/remotes/origin/dev ")).toBe("origin/dev");
    expect(normalizeRef("feat^2")).toBe("feat");
  });

  it("parseCreatedFrom takes the OLDEST creation line (subjects are newest-first)", () => {
    expect(parseCreatedFrom(["branch: Created from HEAD"])).toBe("HEAD");
    expect(
      parseCreatedFrom(["branch: Set up to track origin/x", "branch: Created from dev"]),
    ).toBe("dev");
    expect(parseCreatedFrom(["commit: msg"])).toBe("");
  });

  it("parseCheckoutFrom returns the source of the FIRST checkout into the branch", () => {
    const subjects = [
      "checkout: moving from main to dev", // newest
      "commit: work",
      "checkout: moving from dev to feat",
      "commit: two",
      "checkout: moving from x to feat", // гипотетический позднейший вход
      "checkout: moving from main to feat", // самый старый вход в feat
    ];
    expect(parseCheckoutFrom(subjects, "feat")).toBe("main");
    expect(parseCheckoutFrom(subjects, "ghost")).toBe("");
  });
});

describe("base-branch on a real repository", () => {
  afterEach(() => {
    while (tmpRoots.length) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
  });

  it("directBase reads the explicit creation ref (git branch feat dev)", async () => {
    const dir = makeRepo();
    gitIn(dir, ["branch", "dev"]);
    gitIn(dir, ["branch", "feat", "dev"]);
    expect(await directBase(dir, "feat")).toBe("dev");
    expect(await directBase(dir, "main")).toBe(""); // без reflog создания — честно пусто
  });

  it("directBase resolves `Created from HEAD` through the HEAD reflog", async () => {
    const dir = makeRepo();
    gitIn(dir, ["checkout", "-q", "-b", "dev"]);
    writeFileSync(join(dir, "b.txt"), "two\n");
    gitIn(dir, ["add", "b.txt"]);
    gitIn(dir, ["commit", "-q", "-m", "on dev"]);
    expect(await directBase(dir, "dev")).toBe("main");
  });

  it("baseChain walks the whole ancestry root-first and memoizes it", async () => {
    const dir = makeRepo();
    gitIn(dir, ["checkout", "-q", "-b", "dev"]);
    writeFileSync(join(dir, "b.txt"), "two\n");
    gitIn(dir, ["add", "b.txt"]);
    gitIn(dir, ["commit", "-q", "-m", "on dev"]);
    gitIn(dir, ["checkout", "-q", "-b", "feat"]);
    writeFileSync(join(dir, "c.txt"), "three\n");
    gitIn(dir, ["add", "c.txt"]);
    gitIn(dir, ["commit", "-q", "-m", "on feat"]);

    const memo = new Map<string, string>();
    expect(await baseChain(dir, "feat", memo)).toEqual(["main", "dev"]);
    expect(memo.get("feat")).toBe("dev");
    expect(memo.get("dev")).toBe("main");
    // Мемо греет повторный вызов без новых чтений (ветка не менялась).
    expect(await baseChain(dir, "feat", memo)).toEqual(["main", "dev"]);
  });

  it("unknown or detached input yields an empty chain (chip stays plain)", async () => {
    const dir = makeRepo();
    expect(await baseChain(dir, "nope")).toEqual([]);
    expect(await baseChain(dir, "")).toEqual([]);
  });
});
