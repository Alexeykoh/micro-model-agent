import { homedir } from "os";
import { join } from "path";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { MemoryStore } from "../modules/memory/store";
import type { ReplContext } from "./repl-commands";
import { runMeet } from "../modules/onboarding/meet";
import { runInit } from "../modules/onboarding/init";

const CATEGORIES = ["conventions", "decisions", "errors", "facts"] as const;

/** Pure `/memory` dispatch — returns lines for the caller to render. */
export function applyMemoryCommand(store: MemoryStore, args: string[]): string[] {
  const [sub, ...rest] = args;
  if (!sub) return renderOverview(store);
  switch (sub) {
    case "get": {
      const key = rest[0];
      const prefs = store.getPreferences();
      if (!key || !(key in prefs)) return [pc.yellow(t("repl.memory_not_found", { key: key ?? "" }))];
      return [`${key}=${prefs[key]}`];
    }
    case "set": {
      const [key, ...value] = rest;
      if (!key || value.length === 0) return [t("repl.memory_usage")];
      store.setPreference(key, value.join(" "));
      return [pc.green(t("repl.memory_set", { key, value: value.join(" ") }))];
    }
    case "unset": {
      const key = rest[0];
      if (!key) return [t("repl.memory_usage")];
      const ok = store.deletePreference(key);
      return [ok ? t("repl.memory_unset", { key }) : pc.yellow(t("repl.memory_not_found", { key }))];
    }
    case "find": {
      const query = rest.join(" ");
      if (!query) return [t("repl.memory_usage")];
      const hits = store.search(query);
      return hits.length ? hits.map((h) => `${pc.dim(h.file)}  ${h.match}`) : [t("repl.memory_empty")];
    }
    case "forget": {
      const [category, nRaw] = rest;
      if (!category || !(CATEGORIES as readonly string[]).includes(category)) return [t("repl.memory_usage")];
      const n = parseInt(nRaw ?? "0", 10);
      const ok = n > 0 && store.deleteEntry(category, n);
      return [
        ok
          ? t("repl.memory_forgotten", { category, n: String(n) })
          : pc.yellow(t("repl.memory_entry_not_found", { category, n: String(nRaw ?? n) })),
      ];
    }
    default:
      return [t("repl.memory_usage")];
  }
}

function renderOverview(store: MemoryStore): string[] {
  const out: string[] = [];
  const prefs = store.getPreferences();
  out.push(pc.bold(t("repl.memory_prefs")));
  const entries = Object.entries(prefs);
  if (entries.length === 0) out.push(pc.dim(t("repl.memory_empty")));
  for (const [k, v] of entries) out.push(`  ${k} = ${v}`);
  for (const cat of CATEGORIES) {
    const all = store.read(cat).split(/\r?\n/);
    const idxs = all.map((l, i) => (l.startsWith("- ") ? i : -1)).filter((i) => i >= 0);
    const shown = idxs.slice(-3);
    if (shown.length === 0) continue;
    out.push(pc.dim(`[${cat}]`));
    for (const i of shown) out.push(`  [${idxs.indexOf(i) + 1}] ${all[i]}`);
  }
  return out;
}

/**
 * Register `/memory`, `/meet`, `/init`. `/setup` is intentionally NOT
 * re-registered: `/wizard` (registered in repl-commands) already owns the
 * setup wizard and exposes `setup` as an alias, so a second registration would
 * duplicate/override it. `/setup` therefore reuses that handler.
 */
export function registerOnboardingCommands(ctx: ReplContext): void {
  const store = (): MemoryStore => new MemoryStore(join(homedir(), ".mma", "memory"));

  ctx.registerCommand({
    name: "memory",
    description: t("repl.memory_usage"),
    usage: t("repl.memory_usage"),
    action: async (args: string[]) => {
      for (const l of applyMemoryCommand(store(), args)) ctx.output.writeLine(l);
    },
  });

  ctx.registerCommand({
    name: "meet",
    description: t("cli.meet"),
    aliases: ["познакомимся"],
    usage: t("repl.meet_usage"),
    action: async (args) => {
      const sub = args[0];
      if (sub === "stop" || sub === "end") {
        if (ctx.toolCtx.onboarding) {
          const { exitMeetMode } = await import("../modules/onboarding/mode");
          exitMeetMode(ctx);
          ctx.output.writeLine(t("repl.meet_stop_done"));
        } else {
          ctx.output.writeLine(t("repl.meet_stop_none"));
        }
        return;
      }
      await runMeet(ctx);
    },
  });

  ctx.registerCommand({
    name: "init",
    description: t("cli.init"),
    usage: t("repl.init_usage"),
    action: async () => {
      await runInit(ctx);
    },
  });
}
