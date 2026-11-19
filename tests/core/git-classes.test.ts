import { describe, it, expect } from "vitest";
import {
  classifyGitArgv,
  gitCommandName,
  gitJailViolation,
  gitSubcommand,
  parseGitShellCommand,
} from "../../src/tools/git-classes";

/**
 * Единая классификация git-операций (INV-G1, спека 2026-08-07-git-workflow §3).
 * Таблица — контракт: её же читает bash-политика (command-shapes).
 */
describe("git классификация (INV-G1)", () => {
  it.each([
    [["status"], "read"],
    [["status", "--short", "--branch"], "read"],
    [["log", "--oneline", "-5"], "read"],
    [["diff", "HEAD"], "read"],
    [["show", "HEAD"], "read"],
    [["branch"], "read"],
    [["branch", "-a"], "read"],
    [["branch", "--show-current"], "read"],
    [["tag", "--points-at", "HEAD"], "read"],
    [["rev-parse", "--is-inside-work-tree"], "read"],
    [["ls-files"], "read"],
    [["remote", "-v"], "read"],
    [["worktree", "list"], "read"],
    [["config", "get", "user.name"], "read"],
    [["stash", "list"], "read"],
    [["clean", "-n"], "read"],
    [["status", "--", "src/x.ts"], "read"],
    // mutate: меняют состояние, не уничтожают
    [["add", "src/x.ts"], "mutate"],
    [["commit", "-m", "msg"], "mutate"],
    [["checkout", "-b", "feat/x"], "mutate"],
    [["switch", "main"], "mutate"],
    [["restore", "src/x.ts"], "mutate"],
    [["stash"], "mutate"],
    [["stash", "push", "-u"], "mutate"],
    [["push", "origin", "feat/x"], "mutate"],
    [["fetch", "origin"], "mutate"],
    [["pull"], "mutate"],
    [["merge", "dev"], "mutate"],
    [["branch", "feature/new"], "mutate"],
    [["tag", "v1.0.0"], "mutate"],
    [["reset", "--soft", "HEAD~1"], "mutate"],
    [["reset", "HEAD~1"], "mutate"],
    [["rebase", "origin/dev"], "mutate"],
    [["cherry-pick", "abc123"], "mutate"],
    [["remote", "add", "up", "https://x"], "mutate"],
    [["gc"], "mutate"],
    // destructive: уничтожают историю/данные или исполняют произвольное
    [["push", "--force"], "destructive"],
    [["push", "-f", "origin", "main"], "destructive"],
    [["push", "--force-with-lease"], "destructive"],
    [["push", "--delete", "branch"], "destructive"],
    [["push", "--no-verify"], "destructive"],
    [["reset", "--hard"], "destructive"],
    [["clean", "-fdx"], "destructive"],
    [["clean", "--force"], "destructive"],
    [["branch", "-D", "x"], "destructive"],
    [["branch", "-d", "x"], "destructive"],
    [["branch", "--delete", "x"], "destructive"],
    [["tag", "-d", "v1"], "destructive"],
    [["tag", "--delete", "v1"], "destructive"],
    [["tag", "-f", "v1"], "destructive"],
    [["stash", "drop"], "destructive"],
    [["stash", "clear"], "destructive"],
    [["commit", "--amend"], "destructive"],
    [["commit", "--amend", "--no-edit"], "destructive"],
    [["rebase", "--abort"], "destructive"],
    [["filter-branch"], "destructive"],
    [["config", "--global", "user.name", "x"], "destructive"],
    [["checkout", "--force"], "destructive"],
    [["rm", "-f", "file"], "destructive"],
    [["update-ref", "-d", "refs/x"], "destructive"],
    [["difftool"], "destructive"],
    [["notes", "remove"], "destructive"],
    [["worktree", "prune"], "destructive"],
    // jail: уход из sandbox или подмена конфигурации
    [["-C", "/etc", "status"], "destructive"],
    [["--git-dir", "/tmp/x", "log"], "destructive"],
    [["-c", "core.pager=curl <PII:65b84167565b>"], "destructive"],
    [["--work-tree=C:\\Users", "status"], "destructive"],
    [["--exec-path", "/tmp", "status"], "destructive"],
    // fail-closed: неизвестное имя
    [["totally-made-up"], "destructive"],
    [["credential", "fill"], "destructive"],
  ])("classify git %s → %s", (argv, want) => {
    expect(classifyGitArgv(argv as string[]), `git ${argv.join(" ")}`).toBe(want);
  });

  it("git без аргументов — read (справка ничего не меняет)", () => {
    expect(classifyGitArgv([])).toBe("read");
  });

  it("gitCommandName даёт имя с разрушающим флагом", () => {
    expect(gitCommandName(["reset", "--hard"])).toBe("git reset --hard");
    expect(gitCommandName(["push", "--force"])).toBe("git push --force");
    expect(gitCommandName(["status"])).toBe("git status");
  });

  it("gitSubcommand пропускает глобальные опции со значением", () => {
    expect(gitSubcommand(["--git-dir", "x", "status"])).toBe("status");
    expect(gitSubcommand(["-c", "a=b", "-C", "dir", "log"])).toBe("log");
  });

  it("gitJailViolation ловит только jail-опции", () => {
    expect(gitJailViolation(["status"])).toBeUndefined();
    expect(gitJailViolation(["-C", "/tmp", "status"])).toBe("-C");
    expect(gitJailViolation(["log", "--ext-diff"])).toBe("--ext-diff");
  });
});

describe("разбор shell-строк (паритет для bash-политики)", () => {
  it("извлекает argv git-команд сегмента", () => {
    expect(parseGitShellCommand("git status")).toEqual([["status"]]);
    expect(parseGitShellCommand("cd x && git reset --hard")).toEqual([["reset", "--hard"]]);
    expect(parseGitShellCommand("sudo git push --force")).toEqual([["push", "--force"]]);
    expect(parseGitShellCommand("FOO=1 git commit -m hi; git tag -d v1")).toEqual([
      ["commit", "-m", "hi"],
      ["tag", "-d", "v1"],
    ]);
    expect(parseGitShellCommand("/usr/bin/git log -1")).toEqual([["log", "-1"]]);
  });

  it("не git-команды пропускаются", () => {
    expect(parseGitShellCommand("ls -la")).toEqual([]);
    expect(parseGitShellCommand("gitify run")).toEqual([]);
  });

  it("кавычки склеивают аргументы, а не ломают токенизацию", () => {
    expect(parseGitShellCommand('git commit -m "reset --hard trap"')).toEqual([
      ["commit", "-m", "reset --hard trap"],
    ]);
  });
});
