/**
 * Команды сессий: `/sessions`, `/new`, `/resume`, `/rename`, `/delete`
 * (и `/export` — в `repl-commands-export.ts`).
 *
 * Вынесено из `repl-commands.ts` (правило 6).
 */
import { pc } from "../ui/colors";
import { t } from "../i18n/index";
import { renderTable } from "../ui/table";
import { getMessageText } from "../llm/provider";
import { sessionAge } from "./session-age";
import { registerSessionExportCommands } from "./repl-commands-export";
import type { ReplContext } from "./repl-commands";

export function registerSessionCommands(ctx: ReplContext): void {
  if (!ctx.sessionManager) return;
  registerSessionCoreCommands(ctx);
  registerSessionExportCommands(ctx);
}

function registerSessionCoreCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "sessions",
    description: t("repl.sessions"),
    aliases: ["ls"],
    usage: t("repl.sessions_usage"),
    action: (args: string[]) => {
      if (args[0] === "prune") {
        const dry = args.includes("--dry-run");
        const active = ctx.sessionManager!.getActive();
        const candidates = ctx.sessionManager!.list().filter(
          (s) => s.id !== active && ctx.sessionManager!.isEmptySession(s.id),
        );
        if (candidates.length === 0) {
          ctx.output.writeLine(t("session.prune_empty"));
          return;
        }
        if (!dry) ctx.sessionManager!.pruneEmpty(active ?? undefined);
        ctx.output.writeLine(
          t(dry ? "session.prune_dry" : "session.pruned", { n: candidates.length }),
        );
        for (const s of candidates) {
          ctx.output.writeLine(pc.dim(`   ${s.id.slice(0, 12)}  ${s.name}`));
        }
        return;
      }
      const sessions = ctx.sessionManager!.list();
      const active = ctx.sessionManager!.getActive();
      if (sessions.length === 0) {
        ctx.output.writeLine(t("session.no_sessions_hint"));
        return;
      }
      const rows = sessions.map((s) => [
        s.id === active ? pc.green("●") : "",
        s.id.slice(0, 12),
        s.name,
        sessionAge(s.updatedAt),
        String(s.messageCount),
      ]);
      for (const line of renderTable(
        [
          t("session.col_active"),
          t("session.col_id"),
          t("session.col_name"),
          t("session.col_updated"),
          t("session.col_msgs"),
        ],
        rows,
      )) {
        ctx.output.writeLine(line);
      }
      ctx.output.writeLine(pc.dim(`\n  ${t("repl.resume_hint")}`));
    },
  });

  ctx.registerCommand({
    name: "new",
    description: t("repl.new"),
    aliases: ["create"],
    usage: t("repl.new_usage"),
    action: (args: string[]) => {
      const name = args.join(" ") || undefined;
      const meta = ctx.sessionManager!.create(name);
      ctx.agent.clearContext();
      // План следует за сессией: новая — без плана, трекер сбрасывается.
      const exec = ctx.agent.getModule<{
        switchSession(id: string | null): void;
        getPlanSummary(): string | null;
      }>("execution");
      try {
        exec?.switchSession(meta.id);
      } catch {
        // fail-open: сессия создана, план остался как был
      }
      ctx.output.clearScreen();
      ctx.output.writeLine(
        `${t("session.created", { name: meta.name })} (${pc.dim(meta.id.slice(0, 12))})`,
      );
      ctx.output.writeLine(pc.dim(`  ${t("session.chat_cleared")}\n`));
    },
  });

  ctx.registerCommand({
    name: "resume",
    description: t("repl.resume"),
    aliases: ["switch"],
    usage: t("repl.resume_usage"),
    examples: ["/resume", "/resume my-session"],
    action: (args: string[]) => {
      const query = args.join(" ");
      const sessions = ctx.sessionManager!.list();
      if (!query) {
        ctx.output.writeLine(pc.dim(t("session.available")));
        const active = ctx.sessionManager!.getActive();
        for (const s of sessions) {
          const marker = s.id === active ? pc.green(" *") : "  ";
          ctx.output.writeLine(pc.dim(` ${marker} ${s.id.slice(0, 12)}  ${s.name}`));
        }
        ctx.output.writeLine(pc.dim(`\n  ${t("repl.resume_usage")}`));
        return;
      }
      const match = sessions.find(
        (s) =>
          s.id === query ||
          s.id.startsWith(query) ||
          s.name.toLowerCase().includes(query.toLowerCase()),
      );
      if (!match) {
        ctx.output.writeLine(t("session.no_match", { query }));
        return;
      }
      ctx.sessionManager!.setActive(match.id);
      const history = ctx.sessionManager!.loadHistory();
      ctx.agent.setContext(history);
      // План следует за сессией: трекер переключается на план этой сессии
      // (или пустеет, если у неё плана нет).
      const exec = ctx.agent.getModule<{
        switchSession(id: string | null): void;
        getPlanSummary(): string | null;
      }>("execution");
      let planLine: string | null = null;
      try {
        exec?.switchSession(match.id);
        planLine = exec?.getPlanSummary() ?? null;
      } catch {
        // fail-open: история загружена, план остался как был
      }
      ctx.output.clearScreen();
      ctx.output.writeLine(
        pc.bold(pc.green(t("session.resumed", { name: match.name }))) +
          " " +
          pc.dim(`(${match.id.slice(0, 12)})`) +
          "  —  " +
          match.messageCount +
          " " +
          t("repl.msgs"),
      );
      ctx.output.writeLine(pc.dim("─".repeat(50)));
      if (history.length === 0) {
        ctx.output.writeLine(pc.dim(t("session.no_history")));
      } else {
        ctx.output.writeLine(pc.dim(t("session.chat_history")));
        ctx.output.writeLine("");
        for (const msg of history) {
          if (msg.role === "user") {
            ctx.output.writeLine(pc.cyan(`${t("session.user_label")}:`));
            ctx.output.writeLine(getMessageText(msg.content));
            ctx.output.writeLine("");
          } else if (msg.role === "assistant") {
            ctx.output.writeLine(pc.green(`${t("session.assistant_label")}:`));
            ctx.output.writeLine(getMessageText(msg.content));
            ctx.output.writeLine("");
          }
        }
      }
      ctx.output.writeLine(pc.dim("─".repeat(50)));
      ctx.output.writeLine(pc.dim(`  ${t("session.chat_loaded")}`));
      ctx.output.writeLine(pc.dim(`  ◇ ${planLine ?? t("plan.no_active")}`));
    },
  });

  ctx.registerCommand({
    name: "rename",
    description: t("repl.rename"),
    usage: t("repl.rename_usage"),
    action: (args: string[]) => {
      const name = args.join(" ");
      if (!name) {
        ctx.output.writeLine(t("repl.rename_usage"));
        return;
      }
      const active = ctx.sessionManager!.getActive();
      if (!active) {
        ctx.output.writeLine(t("session.no_active"));
        return;
      }
      ctx.sessionManager!.rename(active, name);
      ctx.output.writeLine(t("session.renamed", { name }));
    },
  });

  ctx.registerCommand({
    name: "delete",
    description: t("repl.delete"),
    aliases: ["rm"],
    usage: t("repl.delete_usage"),
    action: (args: string[]) => {
      const query = args[0];
      if (!query) {
        ctx.output.writeLine(t("repl.delete_usage"));
        return;
      }
      const sessions = ctx.sessionManager!.list();
      const match = sessions.find((s) => s.id === query || s.id.startsWith(query));
      if (!match) {
        ctx.output.writeLine(t("session.no_match", { query }));
        return;
      }
      ctx.sessionManager!.delete(match.id);
      // План следует за сессией: слот удалённой сессии не оставляем мусором.
      try {
        ctx.agent
          .getModule<{ forgetSession(id: string): void }>("execution")
          ?.forgetSession(match.id);
      } catch {
        /* best-effort */
      }
      ctx.output.writeLine(`${t("session.deleted", { id: match.id })}: ${match.name}`);
    },
  });
}
