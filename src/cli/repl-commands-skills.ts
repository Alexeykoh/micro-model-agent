/**
 * Команда REPL `/skill`: вынесена из `repl-commands.ts` (нарезка крупных файлов).
 */
import { pc } from "../ui/colors";
import { t } from "../i18n/index";
import { estimateTokens } from "../llm/token-counter";
import type { ReplContext } from "./repl-commands";

/** Регистрирует `/skill` (list/loaded/load/unload/search). Нет модуля скиллов — скип. */
export function registerSkillCommands(ctx: ReplContext): void {
  if (!ctx.skillsModule) return;

  const listSkills = (): void => {
    const available = ctx.skillsModule!.getAvailable();
    if (available.length === 0) {
      ctx.output.writeLine(t("repl.no_skills"));
      return;
    }
    ctx.output.writeLine(pc.bold(t("repl.available_skills")));
    for (const skill of available) {
      const tokens = estimateTokens(skill.content);
      const loaded = ctx.skillsModule!.getLoaded().some((s) => s.name === skill.name);
      const marker = loaded ? pc.green(` ${t("repl.loaded")}`) : "";
      ctx.output.writeLine(
        `  ${pc.cyan(skill.name)}${marker}  ${pc.dim(`(${tokens} tokens)`)}  ${skill.description.slice(0, 60)}`,
      );
    }
  };

  const listLoaded = (): void => {
    const loaded = ctx.skillsModule!.getLoaded();
    const budget = ctx.skillsModule!.getBudget();
    if (loaded.length === 0) {
      ctx.output.writeLine(t("repl.no_loaded"));
      return;
    }
    ctx.output.writeLine(pc.bold(t("repl.loaded_skills")));
    for (const skill of loaded) {
      const tokens = estimateTokens(skill.content);
      ctx.output.writeLine(
        `  ${pc.cyan(skill.name)}  ${pc.dim(`(${tokens} tokens)`)}  ${skill.description.slice(0, 60)}`,
      );
    }
    ctx.output.writeLine(
      pc.dim(
        `\n  ${t("repl.budget", { used: budget.used, total: budget.total, remaining: budget.remaining })}`,
      ),
    );
  };

  const loadSkill = (args: string[]): void => {
    const arg = args.join(" ");
    if (!arg) {
      ctx.output.writeLine(t("repl.skill_load_usage"));
      return;
    }
    const result = ctx.skillsModule!.loadByName(arg);
    if (result.success) {
      ctx.output.writeLine(pc.green(result.message));
    } else {
      ctx.output.writeLine(pc.red(result.message), "stderr");
    }
  };

  const unloadSkill = (args: string[]): void => {
    const arg = args.join(" ");
    if (!arg) {
      ctx.output.writeLine(t("repl.skill_unload_usage"));
      return;
    }
    if (ctx.skillsModule!.unload(arg)) {
      ctx.output.writeLine(pc.green(t("repl.skill_unloaded", { name: arg })));
    } else {
      ctx.output.writeLine(pc.red(t("repl.skill_not_loaded", { name: arg })), "stderr");
    }
  };

  const searchSkills = (args: string[]): void => {
    const arg = args.join(" ");
    if (!arg) {
      ctx.output.writeLine(t("repl.skill_search_usage"));
      return;
    }
    const results = ctx.skillsModule!.search(arg);
    if (results.length === 0) {
      ctx.output.writeLine(t("repl.no_skill_match", { query: arg }));
      return;
    }
    ctx.output.writeLine(pc.bold(t("repl.skills_matching", { query: arg })));
    for (const skill of results) {
      const tokens = estimateTokens(skill.content);
      ctx.output.writeLine(
        `  ${pc.cyan(skill.name)}  ${pc.dim(`(${tokens} tokens)`)}  ${skill.description.slice(0, 60)}`,
      );
    }
  };

  const skillHandlers: Record<string, (args: string[]) => void> = {
    list: listSkills,
    loaded: listLoaded,
    load: loadSkill,
    unload: unloadSkill,
    search: searchSkills,
  };

  ctx.registerCommand({
    name: "skill",
    description: t("repl.skill"),
    usage: t("repl.skill_usage"),
    action: (args: string[]) => {
      const subcmd = args[0];
      const handler = subcmd ? skillHandlers[subcmd] : skillHandlers.list;
      if (!handler) {
        ctx.output.writeLine(pc.yellow(t("repl.unknown_sub", { cmd: "skill", sub: subcmd })));
        ctx.output.writeLine(t("repl.skill_usage"));
        return;
      }
      handler(args.slice(1));
    },
  });
}
