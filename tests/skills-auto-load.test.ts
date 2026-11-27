import { describe, it, expect } from "vitest";
import { matchSkillByMessage } from "../src/modules/skills/auto-match";
import { autoLoadSkill } from "../src/modules/skills/auto-load";
import type { SkillMeta } from "../src/modules/skills/loader";
import { SkillsModule } from "../src/modules/skills/module";

function skill(name: string, keywords: string[], content = "skill body"): SkillMeta {
  return {
    name,
    kind: "builtin",
    description: name,
    keywords,
    content,
    sourcePath: `${name}.md`,
  };
}

describe("S14: автозагрузка скиллов", () => {
  const git = skill("git-expert", ["git", "branch", "merge", "rebase", "conflict"]);
  const react = skill("react-expert", ["react", "tailwind", "component", "next.js"]);

  it("сопоставляет термины в русском сообщении", () => {
    expect(
      matchSkillByMessage("Создай React компонент с Tailwind CSS", [git, react])?.name,
    ).toBe("react-expert");
  });

  it("не загружает при одном совпадении", () => {
    expect(matchSkillByMessage("Добавь тип TypeScript", [git, react])).toBeNull();
  });

  it("не угадывает при равном счёте", () => {
    const first = skill("first", ["alpha", "beta"]);
    const second = skill("second", ["beta", "gamma"]);
    expect(matchSkillByMessage("alpha beta gamma", [first, second])).toBeNull();
  });

  it("пропускает сообщение с явным load_skill", () => {
    const mod = new SkillsModule([git], 1000);
    autoLoadSkill(
      { lastUserMessage: "git merge conflict — вызови load_skill" },
      {
        available: () => [git],
        isLoaded: (name) => mod.getLoaded().some((s) => s.name === name),
        load: (name) => mod.loadByName(name),
      },
    );
    expect(mod.getLoaded()).toHaveLength(0);
  });

  it("не загружает сверх бюджета", () => {
    const mod = new SkillsModule([git], 1);
    const meta: string[] = [];
    autoLoadSkill(
      {
        lastUserMessage: "resolve git merge conflict",
        onMeta: (chunk: string) => meta.push(chunk),
      },
      {
        available: () => [git],
        isLoaded: (name) => mod.getLoaded().some((s) => s.name === name),
        load: (name) => mod.loadByName(name),
      },
    );
    expect(mod.getLoaded()).toHaveLength(0);
    expect(meta).toHaveLength(0);
  });

  it("тело загруженного скилла попадает в промпт-блоки", () => {
    const mod = new SkillsModule([git], 1000);
    const plugin = mod.getPlugin();
    plugin.onBeforeThink?.({ lastUserMessage: "fix git merge conflict" });
    plugin.onBeforeThink?.({ lastUserMessage: "fix git merge conflict" });

    expect(mod.getLoaded()).toHaveLength(1);
    const bodies = mod.getPromptBlocks().map((block) => block.content).join("\n");
    expect(bodies).toContain("git-expert");
    expect(bodies).toContain("skill body");
    expect(bodies).toContain("[Loaded Skills]");
  });
});
