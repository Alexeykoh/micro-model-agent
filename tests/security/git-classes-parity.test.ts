import { describe, it, expect } from "vitest";
import { isCommandAllowed } from "../../src/modules/security/command-validator";
import { DEFAULT_SECURITY_CONFIG } from "../../src/config/security";
import {
  BALANCED_POLICY,
  PERMISSIVE_POLICY,
  STRICT_POLICY,
} from "../../src/modules/security/security-policies";
import { classifyGitArgv } from "../../src/tools/git-classes";

/**
 * Паритет INV-G1: классификация destructive у тула `git` и у bash-политики —
 * один источник (`src/tools/git-classes.ts`). Если формы разъедутся, дыра
 * вернётся: то, что тул спросит через approve, bash промолча исполнит (или
 * наоборот — bash заблокирует то, что тул считает мутацией).
 */

const DESTRUCTIVE_SHAPES = [
  "git reset --hard",
  "git push --force",
  "git push -f origin main",
  "git push --force-with-lease",
  "git push --delete branch",
  "git clean -fdx",
  "git clean --force -d",
  "git branch -D x",
  "git branch --delete x",
  "git tag -d v1",
  "git stash drop",
  "git stash clear",
  "git commit --amend",
  "git rebase --abort",
  "git filter-branch",
  "git checkout --force",
  "git rm -f file",
  "git update-ref -d refs/x",
  "git -C /etc status",
  "git --git-dir <PATH:1075b0207067> log",
  "git -c core.pager=curl <PII:65b84167565b>",
];

const HARMLESS_SHAPES = [
  "git status",
  "git log --oneline",
  "git diff HEAD",
  "git add src/x.ts",
  "git commit -m msg",
  "git checkout -b feat/x",
  "git push origin feat/x",
  "git reset --soft HEAD~1",
  "git clean -n",
  "git branch --show-current",
];

describe("паритет git-классов: bash ↔ tool (INV-G1)", () => {
  it("все destructive-формы блокируются в bash во всех политиках", () => {
    for (const cmd of DESTRUCTIVE_SHAPES) {
      for (const preset of [STRICT_POLICY, BALANCED_POLICY, PERMISSIVE_POLICY]) {
        expect(isCommandAllowed(cmd, preset.config.bash).allowed, `${cmd} @ ${preset.name}`).toBe(false);
      }
      expect(isCommandAllowed(cmd, DEFAULT_SECURITY_CONFIG.bash).allowed, cmd).toBe(false);
    }
  });

  it("безобидные формы проходят в политиках без whitelist", () => {
    for (const cmd of HARMLESS_SHAPES) {
      for (const preset of [BALANCED_POLICY, PERMISSIVE_POLICY]) {
        expect(isCommandAllowed(cmd, preset.config.bash).allowed, `${cmd} @ ${preset.name}`).toBe(true);
      }
    }
  });

  it("деструктивность в bash совпадает с классом тула", () => {
    // Паритет по построению: bash блокирует ровно то, что классификатор
    // называет destructive. Тест фиксирует это как контракт, а не везение.
    for (const cmd of DESTRUCTIVE_SHAPES) {
      const blocked = !isCommandAllowed(cmd, DEFAULT_SECURITY_CONFIG.bash).allowed;
      const argvOf = cmd.replace(/^git\s+/, "").split(/\s+/);
      expect(blocked, cmd).toBe(classifyGitArgv(argvOf) === "destructive");
    }
    for (const cmd of HARMLESS_SHAPES) {
      const argvOf = cmd.replace(/^git\s+/, "").split(/\s+/);
      expect(classifyGitArgv(argvOf), cmd).not.toBe("destructive");
    }
  });
});
