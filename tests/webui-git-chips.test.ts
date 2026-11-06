import { describe, it, expect } from "vitest";
import { buildGitChips, type GitChipStrings } from "../src/modules/webui/assets/js/feed/git-chips";

/**
 * Чипы git под композером (спека git-workflow §6.3/§7): чистый билдер,
 * поэтому проверяется без DOM. Здесь фиксируются порядок, компактные формы
 * (адаптивность делает CSS, но данные для неё даёт билдер) и скрытие чипов
 * вне репозитория.
 */

const S: GitChipStrings = {
  changes: "changes",
  branchTitle: "branch: {branch}",
  detachedTitle: "detached at {branch}",
  worktrees: "worktree",
  syncTitle: "upstream: {upstream}",
  tag: "tag",
};

const wt = (path: string) => ({ path, branch: "dev" });

const order = (chips: { cls: string }[]): string[] =>
  chips.map(
    (c) =>
      c.cls.split(" ").find((x) => x.startsWith("gchip-") && x !== "gchip-optional") ?? "",
  );

describe("git chips builder (INV-G2)", () => {
  it("hides every chip outside a repository", () => {
    expect(buildGitChips(null, S)).toEqual([]);
    expect(buildGitChips(undefined, S)).toEqual([]);
    expect(buildGitChips({ repo: false }, S)).toEqual([]);
  });

  it("orders chips branch → worktree → dirty → sync → tag", () => {
    const chips = buildGitChips(
      {
        repo: true,
        branch: "dev",
        dirty: 3,
        ahead: 1,
        behind: 2,
        upstream: "origin/dev",
        worktrees: [wt("/a"), wt("/b")],
        tags: ["v1.0.0"],
      },
      S,
    );
    expect(order(chips)).toEqual([
      "gchip-branch",
      "gchip-wt",
      "gchip-dirty",
      "gchip-sync",
      "gchip-tag",
    ]);
  });

  it("keeps the branch chip always, and never marks it optional", () => {
    const chips = buildGitChips({ repo: true, branch: "main" }, S);
    expect(chips).toHaveLength(1);
    expect(chips[0].text).toBe("⎇ main");
    expect(chips[0].cls).not.toContain("gchip-optional");
  });

  it("shows a detached HEAD with the short sha", () => {
    const chips = buildGitChips({ repo: true, branch: "abc1234", detached: true }, S);
    expect(chips[0].text).toBe("⎇ (detached@abc1234)");
    expect(chips[0].title).toBe("detached at abc1234");
  });

  it("omits dirty/sync/tag chips when their counters are zero or absent", () => {
    const chips = buildGitChips({ repo: true, branch: "dev", dirty: 0, ahead: 0, behind: 0 }, S);
    expect(order(chips)).toEqual(["gchip-branch"]);
  });

  it("requires an upstream for the sync chip", () => {
    const withUpstream = buildGitChips(
      { repo: true, branch: "dev", ahead: 2, behind: 1, upstream: "origin/dev" },
      S,
    );
    expect(order(withUpstream)).toContain("gchip-sync");
    const withoutUpstream = buildGitChips({ repo: true, branch: "dev", ahead: 2, behind: 1 }, S);
    expect(order(withoutUpstream)).not.toContain("gchip-sync");
  });

  it("gives compact forms for narrow screens but not for the branch", () => {
    const chips = buildGitChips(
      { repo: true, branch: "dev", dirty: 7, upstream: "origin/dev", ahead: 4, behind: 0 },
      S,
    );
    const dirty = chips.find((c) => c.cls.includes("gchip-dirty"));
    expect(dirty?.short).toBe("●7");
    expect(dirty?.compact).toBe(true);
    const branch = chips.find((c) => c.cls.includes("gchip-branch"));
    expect(branch?.compact).toBe(false);
  });

  it("marks the dirty chip as the action opening the Changes tab", () => {
    const chips = buildGitChips({ repo: true, branch: "dev", dirty: 2 }, S);
    expect(chips.find((c) => c.cls.includes("gchip-dirty"))?.action).toBe("changes");
    expect(chips.find((c) => c.cls.includes("gchip-branch"))?.action).toBeUndefined();
  });

  it("counts extra worktrees beyond the current one", () => {
    const chips = buildGitChips(
      { repo: true, branch: "dev", worktrees: [wt("/a"), wt("/b"), wt("/c")] },
      S,
    );
    const worktrees = chips.find((c) => c.cls.includes("gchip-wt"));
    expect(worktrees?.text).toBe("⌂ 2 worktree");
    expect(worktrees?.short).toBe("⌂2");
    expect(worktrees?.title).toContain("/c");
  });

  it("summarises multiple tags on the head", () => {
    const chips = buildGitChips({ repo: true, branch: "dev", tags: ["v1", "v2"] }, S);
    const tag = chips.find((c) => c.cls.includes("gchip-tag"));
    expect(tag?.text).toBe("◇ v1 +1");
    expect(tag?.title).toBe("v1, v2");
  });
});
