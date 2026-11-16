/**
 * Серверные хендлеры данных (split W12): сессии, экспорт, память, sysprompt,
 * карта проекта, LSP, скиллы, плагины и reload.
 *
 * Всё читает живое состояние демона, поэтому результат совпадает с локальным
 * терминалом на тех же данных.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../../i18n/index";
import {
  isMemoryCategory,
  listEntries,
  MAX_MEMORY_ENTRY_CHARS,
  MEMORY_CATEGORIES,
} from "../../../runtime/memory-view";
import { dispatchInteractive } from "../api/tasks-submit";
import { fail, ok, type CommandCtx } from "./commands-types";

/** Менеджер сессий или null (honest-ошибка у вызывающего). */
function manager(ctx: CommandCtx) {
  return ctx.s.deps.sessionManager ?? null;
}

/** Сессия-владелец: активная после /sessions use, иначе сессия запроса. */
function activeId(ctx: CommandCtx): string {
  return manager(ctx)?.getActiveMeta()?.id ?? ctx.sessionId;
}

/** `/sessions [list | new <name> | use <id|name> | show]`. */
export function sessionsCommand(ctx: CommandCtx, args: string[]): ReturnType<typeof ok> {
  const mgr = manager(ctx);
  if (!mgr) return fail(t("daemon.command_sessions_unavailable"));
  const sub = (args[0] ?? "list").toLowerCase();
  if (sub === "list") {
    return ok(...mgr.list().map((m) => `${m.id}\t${m.name}\t${m.messageCount}`));
  }
  if (sub === "new") {
    const meta = mgr.create(args[1]);
    mgr.setActive(meta.id);
    ctx.s.deps.execModule?.switchSession?.(meta.id);
    return ok(`${meta.id}\t${meta.name}`);
  }
  if (sub === "use") {
    const key = args[1];
    if (!key) return fail(t("daemon.command_usage_session_use"));
    const meta = mgr.get(key) ?? mgr.list().find((m) => m.name === key);
    if (!meta) return fail(t("daemon.command_session_not_found", { id: key }));
    mgr.setActive(meta.id);
    ctx.s.deps.execModule?.switchSession?.(meta.id);
    return ok(`${meta.id}\t${meta.name}`);
  }
  if (sub === "show") {
    const meta = mgr.get(activeId(ctx)) ?? mgr.getActiveMeta();
    return meta ? ok(`${meta.id}\t${meta.name}\t${meta.messageCount}`) : fail(t("daemon.command_no_session"));
  }
  return fail(t("daemon.command_usage_sessions"));
}

/** `/new [name]` — создать и активировать сессию. */
export function newCommand(ctx: CommandCtx, args: string[]): ReturnType<typeof ok> {
  return sessionsCommand(ctx, ["new", ...args]);
}

/** `/resume [id|name]` — активировать сессию. */
export function resumeCommand(ctx: CommandCtx, args: string[]): ReturnType<typeof ok> {
  const mgr = manager(ctx);
  if (!mgr) return fail(t("daemon.command_sessions_unavailable"));
  if (!args[0]) {
    const meta = mgr.getActiveMeta();
    return meta ? ok(`${meta.id}\t${meta.name}`) : fail(t("daemon.command_no_session"));
  }
  return sessionsCommand(ctx, ["use", args[0]]);
}

/** `/rename <name>` — переименовать текущую сессию. */
export function renameCommand(ctx: CommandCtx, args: string[]): ReturnType<typeof ok> {
  const mgr = manager(ctx);
  const name = args.join(" ").trim();
  if (!mgr) return fail(t("daemon.command_sessions_unavailable"));
  if (!name) return fail(t("daemon.command_usage_rename"));
  const meta = mgr.get(activeId(ctx));
  if (!meta) return fail(t("daemon.command_session_not_found", { id: ctx.sessionId }));
  mgr.rename(meta.id, name);
  return ok(`${meta.id}\t${name}`);
}

/** `/delete [id]` — удалить простаивающую сессию. */
export function deleteCommand(ctx: CommandCtx, args: string[]): ReturnType<typeof ok> {
  const mgr = manager(ctx);
  if (!mgr) return fail(t("daemon.command_sessions_unavailable"));
  const id = args[0] ?? activeId(ctx);
  if (!mgr.get(id)) return fail(t("daemon.command_session_not_found", { id }));
  if (ctx.s.pool.isBusy(id) || ctx.s.pool.queueLen(id) > 0) {
    return fail(t("daemon.command_session_busy", { id }));
  }
  ctx.s.pool.drop(id);
  ctx.s.envelopes.clear(id);
  ctx.s.subagentRuns.forgetSession(id);
  ctx.s.deps.execModule?.forgetSession?.(id);
  mgr.delete(id);
  return ok(t("daemon.command_session_deleted", { id }));
}

/** `/export [md|json|jsonl]` — выгрузить историю в каталог сессии. */
export function exportCommand(ctx: CommandCtx, args: string[]): ReturnType<typeof ok> {
  const mgr = manager(ctx);
  if (!mgr) return fail(t("daemon.command_sessions_unavailable"));
  const dir = mgr.getSessionDirectory?.(activeId(ctx));
  if (!dir) return fail(t("daemon.command_session_not_found", { id: ctx.sessionId }));
  const format = (args[0] ?? "md").toLowerCase();
  const history = mgr.getHistory(activeId(ctx));
  const file = join(dir, `export.${format}`);
  if (format === "json") writeFileSync(file, JSON.stringify(history, null, 2), "utf8");
  else if (format === "jsonl") {
    writeFileSync(file, history.map((m) => JSON.stringify(m)).join("\n"), "utf8");
  } else {
    const body = history.map((m) => `## ${m.role}\n\n${m.content}`).join("\n\n");
    writeFileSync(file, body, "utf8");
  }
  return ok(file);
}

/** `/memory [get | find <q> | add <cat> <text> | forget <cat> <n>]`. */
export function memoryCommand(ctx: CommandCtx, args: string[]): ReturnType<typeof ok> {
  const store = ctx.s.deps.memory;
  if (!store) return fail(t("daemon.command_memory_unavailable"));
  const sub = (args[0] ?? "get").toLowerCase();
  if (sub === "get") {
    const lines = Object.entries(store.getPreferences()).map(([k, v]) => `${k}=${v}`);
    for (const category of MEMORY_CATEGORIES) {
      for (const entry of listEntries(store.read(category))) {
        lines.push(`${category}#${entry.n}: ${entry.text}`);
      }
    }
    return ok(...(lines.length ? lines : [t("daemon.command_memory_empty")]));
  }
  if (sub === "find") {
    const needle = args.slice(1).join(" ").toLowerCase();
    if (!needle) return fail(t("daemon.command_usage_memory"));
    const hits: string[] = [];
    for (const category of MEMORY_CATEGORIES) {
      for (const entry of listEntries(store.read(category))) {
        if (entry.text.toLowerCase().includes(needle)) hits.push(`${category}#${entry.n}: ${entry.text}`);
      }
    }
    return ok(...(hits.length ? hits : [t("daemon.command_memory_none")]));
  }
  if (sub === "add") {
    const category = args[1] ?? "";
    const text = args.slice(2).join(" ").trim();
    if (!isMemoryCategory(category) || !text) return fail(t("daemon.command_usage_memory"));
    store.append(category, text.slice(0, MAX_MEMORY_ENTRY_CHARS));
    return ok(t("daemon.command_memory_added"));
  }
  if (sub === "forget") {
    const category = args[1] ?? "";
    const n = Number(args[2]);
    if (!isMemoryCategory(category) || !Number.isInteger(n)) {
      return fail(t("daemon.command_usage_memory"));
    }
    return store.deleteEntry(category, n)
      ? ok(t("daemon.command_memory_forgot"))
      : fail(t("daemon.command_not_found"));
  }
  return fail(t("daemon.command_usage_memory"));
}

/** `/sysprompt [--full]` — состав системного промпта активного раннера. */
export function syspromptCommand(ctx: CommandCtx, args: string[]): ReturnType<typeof ok> {
  const runner = ctx.s.pool.getRunner(activeId(ctx));
  if (!runner) return fail(t("daemon.command_no_runner"));
  const info = runner.agent.getSystemPromptInfo();
  const lines = [`tokens: ${info.tokenCount}`];
  if (info.excluded.length) lines.push(`excluded: ${info.excluded.length}`, ...info.excluded);
  if (args.includes("--full")) lines.push(...info.text.split("\n"));
  return ok(...lines);
}

/** `/map` — статистика карты проекта. */
export function mapCommand(ctx: CommandCtx): ReturnType<typeof ok> {
  const info = ctx.s.deps.indexer?.mapInfo?.() as
    | { files?: number; symbols?: number; tokens?: number }
    | null
    | undefined;
  if (!info) return fail(t("daemon.command_map_missing"));
  return ok(`files: ${info.files ?? 0} · symbols: ${info.symbols ?? 0} · tokens: ${info.tokens ?? 0}`);
}

/** `/lsp [doctor]` — флаги или диагностика workspace. */
export async function lspCommand(
  ctx: CommandCtx,
  args: string[],
): Promise<ReturnType<typeof ok>> {
  const lsp = ctx.s.deps.lsp;
  if (!lsp) return fail(t("daemon.command_lsp_unavailable"));
  if ((args[0] ?? "").toLowerCase() === "doctor") {
    const base = ctx.s.deps.baseDir ?? process.cwd();
    const result = await lsp.diagnose(base);
    return ok(JSON.stringify(result));
  }
  const flags = lsp.getFlags?.() ?? { enabled: true, offline: false };
  return ok(`enabled: ${flags.enabled} · offline: ${flags.offline}`);
}

/** `/skill` — загруженные и доступные скиллы. */
export function skillCommand(ctx: CommandCtx): ReturnType<typeof ok> {
  const skills = ctx.s.deps.skills;
  if (!skills) return fail(t("daemon.command_skills_unavailable"));
  const loaded = new Set(skills.getLoaded().map((s) => s.name));
  return ok(
    ...skills.getAvailable().map((s) => `${loaded.has(s.name) ? "* " : "  "}${s.name}`),
  );
}

/** `/plugins [<name> on|off]` — список и живой тумблер. */
export function pluginsCommand(ctx: CommandCtx, args: string[]): ReturnType<typeof ok> {
  const plugins = ctx.s.deps.plugins;
  if (!plugins) return fail(t("daemon.command_plugins_unavailable"));
  const name = args[0];
  if (name && (args[1] === "on" || args[1] === "off")) {
    const on = args[1] === "on";
    const record = plugins.getRecords().find((p) => p.name === name);
    if (!record) return fail(t("daemon.command_not_found"));
    if (record.system && !on) return fail(t("daemon.command_plugin_system"));
    plugins.setEnabled(name, on);
    return ok(`${name}: ${on ? "on" : "off"}`);
  }
  return ok(
    ...plugins.getRecords().map((p) => `${plugins.isEnabled(p.name) ? "* " : "  "}${p.name}`),
  );
}

/** `/reload` — перечитать конфиг, AGENTS.md, плагины и скиллы с диска. */
export async function reloadCommand(
  ctx: CommandCtx,
): Promise<ReturnType<typeof ok>> {
  const plugins = ctx.s.deps.plugins;
  if (!plugins) return fail(t("daemon.command_plugins_unavailable"));
  plugins.reload();
  ctx.s.deps.skills?.reloadSources?.();
  const sources = await ctx.s.deps.reloadSources?.();
  if (sources) {
    await ctx.s.deps.reconfigure?.(ctx.s.config);
    ctx.s.pool.dropIdle();
  }
  const lines = [
    t("daemon.command_reloaded"),
    `model ${ctx.s.config.model}`,
    `context ${ctx.s.config.contextWindow}`,
  ];
  if (sources) {
    lines.push(
      `AGENTS.md: ${sources.files.length} file(s), ${sources.instructions.length} block(s)`,
    );
  }
  return ok(...lines);
}

/** `/run <prompt…>` — поставить ход тем же путём, что submit (split W13). */
export function runCommand(ctx: CommandCtx, args: string[]): ReturnType<typeof ok> {
  const text = args.join(" ").trim();
  if (!text) return fail(t("repl.run_usage"));
  const created = dispatchInteractive(ctx.s, ctx.sessionId, text, ctx.s.tenant, []);
  if (!created.ok) return fail(t("daemon.command_queue_full"));
  return ok(t("daemon.command_run_started", { jobId: created.task.jobId }));
}
