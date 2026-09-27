import { pc } from "../ui/colors";
import { resolveVerbosity } from "../ui/theme";
import { readMmaVersion } from "../core/version";
import { renderTable } from "../ui/table";
import { t, setLocale } from "../i18n/index";
import { runSetup } from "./setup";
import { applyAnswersToConfig } from "./setup-order";
import { saveConfig } from "../config/config";
import { HOSTED_BASE_URLS } from "../modules/providers/presets";
import { providerNameTaken } from "../modules/providers/naming";
import { budgetBreakdownLines } from "../config/budget";
import {
  setConfigValue,
  getConfigValue,
  resolveConfigKey,
  canonicalKeys,
  keysForGroup,
  configDefs,
  formatConfigValue,
  type ConfigKeyDef,
  type ConfigSetResult,
} from "../config/registry";
import {
  formatExport,
  redactExport,
  sanitizeFileName,
  extensionFor,
  type ExportFormat,
} from "../modules/session/export";
import { getMessageText } from "../llm/provider";
import { join, dirname } from "path";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import type { LineInput } from "../ui/line-editor";
import type { Agent } from "../core/agent";
import type { AppConfig } from "../config/types";
import type { SessionManager } from "../modules/session/manager";
import type { SkillsModule } from "../modules/skills/module";
import type { PluginManager } from "../modules/plugins/manager";
import type { IndexerModule } from "../modules/indexer/module";
import { runMapAction } from "../modules/indexer/map-command";
import { registerOnboardingCommands } from "./onboarding-commands";
import { errMsg } from "../utils";
import type { OutputChannel } from "../output";
import { globalExportsDir } from "../config/paths";
import { registerLspCommands } from "./repl-commands-lsp";
import { registerSkillCommands } from "./repl-commands-skills";

const version = readMmaVersion();

export interface SlashCommand {
  name: string;
  description: string;
  aliases?: string[];
  usage?: string;
  /** Short worked examples shown by `/help <command>`. */
  examples?: string[];
  action(args: string[]): void | Promise<void>;
}

export interface ReplContext {
  readonly config: AppConfig;
  readonly agent: Agent;
  /** Shared tool context — carries mode-scoped state (allowlist, onboarding). */
  readonly toolCtx: import("../tools/types").ToolContext;
  readonly rl: LineInput;
  readonly sessionManager?: SessionManager;
  readonly skillsModule?: SkillsModule;
  readonly pluginManager?: PluginManager;
  readonly configDir: string;
  readonly baseDir: string;
  /** Single terminal writer — commands must never write to console/stdout directly. */
  readonly output: OutputChannel;
  registerCommand(cmd: SlashCommand): void;
  runAgent(input: string): Promise<void>;
  withExclusiveInput(fn: () => Promise<void>): Promise<void>;
  showHelp(command?: string): void;
  /** Rebuild the command registry + completer (used after a locale change). */
  reregisterCommands(): void;
  /** Boot snapshot of managed config keys for `/config reset`. */
  getConfigSnapshot(): ReadonlyMap<string, unknown>;
  /** Cached model ids from the active provider (may be empty when offline). */
  knownModels(): string[];
  setupCompleter(): void;
  refreshModelCache(): void;
  attachHostBridge(pluginManager?: PluginManager): void;
  /** Перезагрузка агента и модулей (команда /reload). */
  reload(): Promise<void>;
  stop(): void;
}

export const COMMAND_GROUPS: Record<string, string> = {
  help: "general",
  exit: "general",
  clear: "general",
  run: "general",
  image: "general",
  config: "agent",
  status: "agent",
  reasoning: "agent",
  verbose: "agent",
  provider: "agent",
  model: "agent",
  context: "agent",
  reload: "agent",
  wizard: "agent",
  meet: "agent",
  init: "agent",
  memory: "agent",
  sysprompt: "agent",
  map: "agent",
  lsp: "agent",
  security: "agent",
  sessions: "session",
  new: "session",
  resume: "session",
  rename: "session",
  delete: "session",
  export: "session",
  skill: "skill",
  plugins: "agent",
};

export function registerAllCommands(ctx: ReplContext): void {
  registerBuiltinCommands(ctx);
  registerMmaCommands(ctx);
  registerOnboardingCommands(ctx);
  registerSessionCommands(ctx);
  registerSkillCommands(ctx);
}

function registerBuiltinCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "help",
    description: t("repl.help"),
    usage: t("repl.help_usage"),
    examples: ["/help", "/help config"],
    action: (args: string[]) => ctx.showHelp(args[0]),
  });
  ctx.registerCommand({
    name: "exit",
    description: t("repl.exit"),
    aliases: ["quit", "q"],
    usage: t("repl.exit_usage"),
    action: () => ctx.stop(),
  });
  ctx.registerCommand({
    name: "clear",
    description: t("repl.clear"),
    usage: t("repl.clear_usage"),
    action: () => {
      ctx.output.clearScreen();
      ctx.output.writeLine(pc.dim(t("repl.clear_hint")));
    },
  });
}

function registerRunCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "run",
    description: t("repl.run"),
    usage: t("repl.run_usage"),
    action: async (args: string[]) => {
      if (args.length === 0) {
        ctx.output.writeLine(t("repl.run_usage"));
        return;
      }
      const prompt = args.join(" ");
      await ctx.runAgent(prompt);
    },
  });
  ctx.registerCommand({
    name: "image",
    description: t("repl.image"),
    aliases: ["img"],
    usage: t("repl.image_usage"),
    action: async (args: string[]) => {
      const source = args.join(" ");
      if (!source) {
        ctx.output.writeLine(t("repl.image_usage"));
        return;
      }
      try {
        const { loadFileAsDataUrl, loadUrlAsDataUrl, readClipboardImage } =
          await import("../llm/image-utils");
        const { existsSync } = await import("fs");
        const { resolve } = await import("path");

        let dataUrl: string;
        let label: string;

        if (source.toLowerCase() === "clipboard") {
          const clipBuf = await readClipboardImage();
          if (!clipBuf) {
            ctx.output.writeLine(pc.yellow(t("image.clipboard_empty")));
            return;
          }
          const { bufferToDataUrl } = await import("../llm/image-utils");
          const result = await bufferToDataUrl(clipBuf);
          dataUrl = result.dataUrl;
          label = "clipboard";
        } else if (source.startsWith("http://") || source.startsWith("https://")) {
          const result = await loadUrlAsDataUrl(source);
          dataUrl = result.dataUrl;
          label = source;
        } else {
          const absPath = resolve(process.cwd(), source);
          if (!existsSync(absPath)) {
            ctx.output.writeLine(pc.red(t("image.not_found", { path: source })), "stderr");
            return;
          }
          const result = await loadFileAsDataUrl(absPath);
          dataUrl = result.dataUrl;
          label = source;
        }

        const contextManager = ctx.agent.contextManager;
        if (!contextManager) {
          ctx.output.writeLine(pc.red(t("image.no_context")), "stderr");
          return;
        }

        contextManager.addPendingImage({
          type: "image_url",
          image_url: { url: dataUrl },
        });

        const sizeKb = Math.round((dataUrl.length * 3) / 4 / 1024);
        ctx.output.writeLine(
          pc.green(t("image.attached", { source: label, size: `${sizeKb} KB` })),
        );
      } catch (err: any) {
        ctx.output.writeLine(pc.red(t("image.error", { message: err.message })), "stderr");
      }
    },
  });
}

const SUGAR_HINTS: Record<string, string> = {
  model: "/model use <name>",
  "provider.active": "/provider use <name>",
  contextWindow: "/context <size>",
  "contextBudget.systemPrompt": "/context system <share>",
  "contextBudget.responseReserve": "/context reserve <share>",
  showReasoning: "/reasoning show | hide",
  "reasoning.mode": "/reasoning level <level>",
  "ui.verbosity": "/verbose <level>",
};

function changeHint(def: ConfigKeyDef): string {
  if (def.readOnly) return t("config.read_only_hint");
  return SUGAR_HINTS[def.key] ?? `/config ${def.key} <value>`;
}

function configValueHint(def?: ConfigKeyDef): string {
  if (!def) return "";
  switch (def.valueType) {
    case "enum":
      return t("config.hint_enum", { values: (def.enumValues ?? []).join(", ") });
    case "bool":
      return t("config.hint_bool");
    case "share":
      return t("config.hint_share");
    case "int":
      return t("config.hint_int", { min: String(def.min ?? 1) });
    default:
      return t("config.hint_string");
  }
}

function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return dp[b.length];
}

function nearestConfigKey(input: string): string | null {
  const names = canonicalKeys();
  let best: { name: string; dist: number } | null = null;
  for (const name of names) {
    const d = editDistance(input.toLowerCase(), name.toLowerCase());
    if (best === null || d < best.dist) best = { name, dist: d };
  }
  if (!best) return null;
  const threshold = Math.max(2, Math.floor(best.name.length / 3));
  return best.dist <= threshold ? best.name : null;
}

function renderConfigError(
  ctx: ReplContext,
  result: { reason: string; input: string; key?: string; def?: ConfigKeyDef },
): void {
  const key = result.key ?? result.input;
  switch (result.reason) {
    case "unknown-key": {
      const suggestion = nearestConfigKey(result.input);
      const suffix = suggestion
        ? t("config.suggest", { name: suggestion })
        : t("config.valid_keys", { keys: canonicalKeys().join(", ") });
      ctx.output.writeLine(
        pc.yellow(t("config.unknown_key", { key: result.input, suggestion: suffix })),
        "stderr",
      );
      return;
    }
    case "read-only":
      ctx.output.writeLine(pc.yellow(t("config.read_only", { key })), "stderr");
      return;
    case "range":
      ctx.output.writeLine(pc.yellow(t("config.range", { key })), "stderr");
      return;
    case "combined":
      ctx.output.writeLine(pc.yellow(t("config.combined")), "stderr");
      return;
    default:
      ctx.output.writeLine(
        pc.yellow(t("config.invalid_value", { key, hint: configValueHint(result.def) })),
        "stderr",
      );
  }
}

function applyConfigSideEffects(
  ctx: ReplContext,
  result: ConfigSetResult & { ok: true },
): void {
  if (result.key === "ui.verbosity") {
    // Mirror the startup rule (`main.ts`): structured info logs and loop
    // diagnostics are chat-visible only in verbose mode.
    const verbose = (result.value as string) === "verbose";
    ctx.output.setSuppressInfoLogs(!verbose);
    ctx.output.setShowDiagnostics(verbose);
  } else if (result.key === "reasoning.mode") {
    ctx.agent.setReasoningLevel(result.value as "auto" | "default" | "none" | "low" | "medium" | "high" | "max");
  } else if (result.key === "locale") {
    setLocale(result.value as string);
  }
}

function persistConfig(ctx: ReplContext): void {
  const configPath = join(ctx.configDir, "config.json");
  saveConfig(ctx.config, configPath, dirname(configPath));
}

/**
 * The single write path for every settings mutation. Sugar commands must call
 * this too, so validation, side effects, persistence and reconfigure never
 * drift apart.
 */
async function mutateConfig(
  ctx: ReplContext,
  key: string,
  raw: string,
): Promise<ConfigSetResult> {
  const result = setConfigValue(ctx.config, key, raw);
  if (!result.ok) return result;
  applyConfigSideEffects(ctx, result);
  persistConfig(ctx);
  if (result.reconfigure) await ctx.agent.reconfigure(ctx.config);
  if (result.key === "locale") ctx.reregisterCommands();
  return result;
}

function reportSaved(ctx: ReplContext, result: ConfigSetResult & { ok: true }): void {
  ctx.output.writeLine(pc.green(t("config.saved", { key: result.key })));
}

function rawFromValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function printConfigTable(ctx: ReplContext, defs?: ConfigKeyDef[]): void {
  const list = defs ?? configDefs();
  const rows = list.map((def) => [
    def.key,
    formatConfigValue(def.get(ctx.config)),
    def.domain,
    changeHint(def),
  ]);
  ctx.output.writeLine(pc.bold(t("config.header")));
  for (const line of renderTable(
    [
      t("config.col_setting"),
      t("config.col_value"),
      t("config.col_domain"),
      t("config.col_change"),
    ],
    rows,
  )) {
    ctx.output.writeLine(line);
  }
  const meta = ctx.sessionManager?.getActiveMeta();
  if (meta) {
    ctx.output.writeLine(
      pc.dim(
        t("config.session_line", {
          name: meta.name,
          id: meta.id,
          count: String(meta.messageCount),
        }),
      ),
    );
  }
  ctx.output.writeLine(pc.dim(t("config.usage_hint")));
}

function confirm(ctx: ReplContext, prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    void ctx.withExclusiveInput(async () => {
      await new Promise<void>((done) => {
        ctx.rl.question(prompt, (answer) => {
          resolve(/^y(es)?$/i.test(answer.trim()));
          done();
        });
      });
    });
  });
}

async function runConfigReset(ctx: ReplContext, rest: string[]): Promise<void> {
  const snapshot = ctx.getConfigSnapshot();
  const yes = rest.includes("--yes");
  const all = rest.includes("--all");
  const target = rest.find((a) => !a.startsWith("--"));

  if (all) {
    const changed = canonicalKeys().filter((k) => {
      const def = resolveConfigKey(k);
      if (!def || !snapshot.has(k)) return false;
      return rawFromValue(def.get(ctx.config)) !== rawFromValue(snapshot.get(k));
    });
    if (changed.length === 0) {
      ctx.output.writeLine(t("config.reset_none"));
      return;
    }
    if (!yes) {
      if (!process.stdin.isTTY) {
        ctx.output.writeLine(pc.yellow(t("config.reset_all_needs_yes")), "stderr");
        return;
      }
      const ok = await confirm(
        ctx,
        t("config.reset_all_confirm", { count: String(changed.length) }),
      );
      if (!ok) {
        ctx.output.writeLine(t("config.reset_cancelled"));
        return;
      }
    }
    let anyReconfig = false;
    let localeChanged = false;
    for (const k of changed) {
      const result = setConfigValue(ctx.config, k, rawFromValue(snapshot.get(k)));
      if (result.ok) {
        applyConfigSideEffects(ctx, result);
        anyReconfig = anyReconfig || result.reconfigure;
        localeChanged = localeChanged || result.key === "locale";
      }
    }
    persistConfig(ctx);
    if (anyReconfig) await ctx.agent.reconfigure(ctx.config);
    if (localeChanged) ctx.reregisterCommands();
    ctx.output.writeLine(
      pc.green(t("config.reset_all_done", { count: String(changed.length) })),
    );
    return;
  }

  if (!target) {
    ctx.output.writeLine(t("config.reset_usage"));
    return;
  }
  const def = resolveConfigKey(target);
  if (!def) {
    renderConfigError(ctx, { reason: "unknown-key", input: target });
    return;
  }
  if (def.readOnly || !snapshot.has(def.key)) {
    ctx.output.writeLine(t("config.reset_unchanged", { key: def.key }));
    return;
  }
  if (rawFromValue(def.get(ctx.config)) === rawFromValue(snapshot.get(def.key))) {
    ctx.output.writeLine(t("config.reset_unchanged", { key: def.key }));
    return;
  }
  const result = await mutateConfig(ctx, def.key, rawFromValue(snapshot.get(def.key)));
  if (!result.ok) {
    renderConfigError(ctx, result);
    return;
  }
  ctx.output.writeLine(
    pc.green(t("config.reset_ok", { key: result.key, value: result.display })),
  );
}

function printReasoningStatus(ctx: ReplContext): void {
  const display = ctx.config.showReasoning ? t("reasoning.on") : t("reasoning.off");
  const mode = ctx.config.reasoning?.mode ?? "auto";
  const auto = mode === "auto" ? t("reasoning.auto_on") : t("reasoning.auto_off");
  ctx.output.writeLine(t("reasoning.status", { display, level: mode, auto }));
}

function registerConfigCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "config",
    description: t("repl.config"),
    usage: t("repl.config_usage"),
    examples: ["/config", "/config model", "/config reasoning.mode high", "/config reset ui.verbosity"],
    action: async (args: string[]) => {
      // Subcommand routing: `/config migrate`. A separate registration with
      // a space in the name was unreachable — the dispatcher splits input on
      // whitespace, so "/config migrate" always resolved to plain "config".
      if ((args[0] ?? "").trim().toLowerCase() === "migrate") {
        return runConfigMigrate(ctx);
      }
      if (args.length === 0) {
        printConfigTable(ctx);
        return;
      }
      if (args[0] === "reset") {
        await runConfigReset(ctx, args.slice(1));
        return;
      }
      const name = args[0];
      if (args.length === 1) {
        const group = keysForGroup(name);
        if (group.length > 0) {
          printConfigTable(ctx, group);
          return;
        }
        const got = getConfigValue(ctx.config, name);
        if (!got.ok) {
          renderConfigError(ctx, got);
          return;
        }
        ctx.output.writeLine(`${got.key} = ${got.display}`);
        return;
      }
      const raw = args.slice(1).join(" ");
      const result = await mutateConfig(ctx, name, raw);
      if (!result.ok) {
        renderConfigError(ctx, result);
        return;
      }
      reportSaved(ctx, result);
      if (result.key === "model") {
        const known = ctx.knownModels();
        if (known.length > 0 && !known.includes(String(result.value))) {
          ctx.output.writeLine(pc.yellow(t("model.not_in_list", { name: String(result.value) })));
        }
      }
    },
  });
  ctx.registerCommand({
    name: "reasoning",
    description: t("repl.reasoning"),
    usage: t("repl.reasoning_usage"),
    examples: ["/reasoning", "/reasoning show", "/reasoning level high"],
    action: async (args: string[]) => {
      const sub = args[0]?.trim().toLowerCase();
      if (!sub) {
        printReasoningStatus(ctx);
        return;
      }
      if (sub === "show" || sub === "on" || sub === "hide" || sub === "off") {
        const on = sub === "show" || sub === "on";
        const result = await mutateConfig(ctx, "showReasoning", on ? "on" : "off");
        if (!result.ok) {
          renderConfigError(ctx, result);
          return;
        }
        ctx.output.writeLine(
          pc.green(
            t("reasoning.display_set", { state: on ? t("reasoning.on") : t("reasoning.off") }),
          ),
        );
        return;
      }
      if (sub === "level") {
        const lvl = args[1]?.trim().toLowerCase();
        if (!lvl) {
          ctx.output.writeLine(t("repl.reasoning_usage"));
          return;
        }
        const result = await mutateConfig(ctx, "reasoning.mode", lvl);
        if (!result.ok) {
          renderConfigError(ctx, result);
          return;
        }
        ctx.output.writeLine(pc.green(t("repl.reasoning_level_set", { level: lvl })));
        if (lvl !== "auto") ctx.output.writeLine(pc.dim(t("reasoning.auto_off_hint")));
        return;
      }
      ctx.output.writeLine(pc.yellow(t("reasoning.unknown_sub", { sub })));
      ctx.output.writeLine(t("repl.reasoning_usage"));
    },
  });
  ctx.registerCommand({
    name: "verbose",
    description: t("repl.verbose"),
    usage: t("repl.verbose_usage"),
    examples: ["/verbose", "/verbose normal"],
    action: async (args: string[]) => {
      const level = args[0]?.trim().toLowerCase();
      if (!level) {
        ctx.output.writeLine(
          t("verbose.status", { level: resolveVerbosity(ctx.config.ui) }),
        );
        return;
      }
      const result = await mutateConfig(ctx, "ui.verbosity", level);
      if (!result.ok) {
        renderConfigError(ctx, result);
        return;
      }
      ctx.output.writeLine(pc.green(t("repl.verbose_set", { level: result.display })));
    },
  });
  ctx.registerCommand({
    name: "status",
    description: t("repl.status"),
    usage: t("repl.status_usage"),
    action: () => {
      const providers = ctx.agent.listProviders();
      const active = providers.find((p) => p.active);
      const providerLabel = active ? active.label : ctx.config.provider.type;
      const parts = [ctx.config.model, providerLabel];
      const meta = ctx.sessionManager?.getActiveMeta();
      if (meta) parts.push(`${meta.name} (${meta.messageCount} ${t("repl.msgs")})`);
      parts.push(`${ctx.config.contextWindow} tok`);
      ctx.output.writeLine(parts.join(pc.dim(" · ")));
    },
  });
  ctx.registerCommand({
    name: "wizard",
    description: t("repl.wizard"),
    aliases: ["setup"],
    usage: t("repl.wizard_usage"),
    action: async () => {
      ctx.output.writeLine(pc.yellow(t("repl.wizard_running")));
      await ctx.withExclusiveInput(async () => {
        const answers = await runSetup(ctx.rl);
        const configPath = join(ctx.configDir, "config.json");
        applyAnswersToConfig(ctx.config, answers);
        saveConfig(ctx.config, configPath, dirname(configPath));
        await ctx.agent.reconfigure(ctx.config);
        ctx.output.writeLine(pc.green(t("cli.config_saved")));
      });
    },
  });
  ctx.registerCommand({
    name: "sysprompt",
    description: t("repl.sysprompt_desc"),
    usage: t("repl.sysprompt_usage"),
    examples: ["/sysprompt", "/sysprompt --full"],
    action: (args: string[]) => {
      const info = ctx.agent.getSystemPromptInfo();
      const full = args.includes("--full");
      ctx.output.writeLine(pc.bold(t("repl.sysprompt_tokens", { count: String(info.tokenCount) })));
      if (info.excluded.length > 0) {
        ctx.output.writeLine(
          pc.yellow(t("repl.excluded_blocks", { count: String(info.excluded.length) })),
        );
        for (const e of info.excluded) {
          ctx.output.writeLine(pc.dim(`  - ${e.slice(0, 80)}${e.length > 80 ? "..." : ""}`));
        }
      }
      if (full) {
        ctx.output.writeLine(pc.dim("─".repeat(60)));
        for (const line of info.text.split("\n")) {
          ctx.output.writeLine(line);
        }
        ctx.output.writeLine(pc.dim("─".repeat(60)));
      } else {
        ctx.output.writeLine(pc.dim(t("repl.sysprompt_full_hint")));
      }
    },
  });
  ctx.registerCommand({
    name: "map",
    description: t("repl.map"),
    usage: t("repl.map_usage"),
    action: async (args: string[]) => {
      const indexer = ctx.agent.getModule<IndexerModule>("indexer");
      if (!indexer) {
        ctx.output.writeLine(pc.yellow(t("indexer.not_indexed")));
        return;
      }
      const action = args[0] || "summary";
      const query = args.slice(1).join(" ");
      const result = await runMapAction(indexer, action, query);
      ctx.output.writeLine(result.output);
    },
  });
}

function registerProviderCommands(ctx: ReplContext): void {
  const list = (): void => {
    const providers = ctx.agent.listProviders();
    if (providers.length === 0) {
      ctx.output.writeLine(`${t("repl.provider_current")}  ${ctx.config.provider.type}`);
      ctx.output.writeLine(`  ${ctx.config.provider.baseUrl}`);
      return;
    }
    ctx.output.writeLine(t("repl.provider_current"));
    for (const p of providers) {
      const marker = p.active ? pc.green("* ") : "  ";
      ctx.output.writeLine(` ${marker}${p.label}  (${pc.dim(p.type)})  ${pc.dim(p.baseUrl)}`);
    }
  };

  const use = async (args: string[]): Promise<void> => {
    const name = args[0];
    if (!name) {
      ctx.output.writeLine(t("repl.provider_usage"));
      return;
    }
    const result = await mutateConfig(ctx, "provider.active", name);
    if (!result.ok) {
      renderConfigError(ctx, result);
      return;
    }
    ctx.refreshModelCache();
    ctx.output.writeLine(pc.green(t("repl.provider_set", { name })));
    reportSaved(ctx, result);
  };

  const add = async (args: string[]): Promise<void> => {
    const flags: Record<string, string> = {};
    let name: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith("--")) {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) {
          ctx.output.writeLine(
            pc.red(t("repl.provider_add_missing_value", { flag: arg })),
            "stderr",
          );
          return;
        }
        flags[arg.slice(2)] = value;
        i++;
      } else if (name === undefined) {
        name = arg;
      }
    }
    if (!name) {
      ctx.output.writeLine(t("repl.provider_usage"));
      return;
    }
    for (const flag of ["priority", "context-window", "rpm", "parallel"]) {
      const v = flags[flag];
      if (v !== undefined && !Number.isFinite(Number(v))) {
        ctx.output.writeLine(
          pc.red(t("repl.provider_add_invalid_number", { flag: `--${flag}`, value: v })),
          "stderr",
        );
        return;
      }
    }
    const entries = Array.isArray(ctx.config.provider.entries) ? ctx.config.provider.entries : [];
    if (entries.length === 0) {
      entries.push({
        type: ctx.config.provider.type,
        label: ctx.config.provider.type,
        baseUrl: ctx.config.provider.baseUrl,
        apiKey: ctx.config.provider.apiKey,
      });
    }
    const baseUrl =
      flags.url || HOSTED_BASE_URLS[name] || HOSTED_BASE_URLS[`opencode-${name}`] || "";
    if (!baseUrl) {
      ctx.output.writeLine(pc.red(t("cli.provider_no_url", { name })), "stderr");
      return;
    }
    if (providerNameTaken(entries, name)) {
      ctx.output.writeLine(pc.red(t("cli.provider_name_conflict", { name })), "stderr");
      return;
    }
    entries.push({
      type: name,
      label: name,
      baseUrl,
      apiKey: flags.key,
      ...(flags.priority !== undefined ? { priority: Number(flags.priority) } : {}),
      ...(flags["context-window"] !== undefined
        ? { contextWindow: Number(flags["context-window"]) }
        : {}),
      ...(flags.rpm !== undefined || flags.parallel !== undefined
        ? {
            rateLimits: {
              maxRequestsPerMinute: Number(flags.rpm ?? 0) || 60,
              maxParallelTasks: Number(flags.parallel ?? 0) || 1,
            },
          }
        : {}),
    });
    ctx.config.provider.entries = entries;
    ctx.config.provider.active = ctx.config.provider.active || ctx.config.provider.type;
    persistConfig(ctx);
    await ctx.agent.reconfigure(ctx.config);
    ctx.output.writeLine(pc.green(t("cli.provider_added", { name })));
    ctx.output.writeLine(t("repl.provider_switch_hint", { name }));
  };

  const handlers: Record<string, (args: string[]) => void | Promise<void>> = {
    list,
    use,
    add,
  };

  ctx.registerCommand({
    name: "provider",
    description: t("repl.provider_list"),
    usage: t("repl.provider_usage"),
    examples: ["/provider list", "/provider use openrouter", "/provider add openai --key sk-..."],
    action: async (args: string[]) => {
      const subcmd = args[0];
      const handler = subcmd ? handlers[subcmd] : handlers.list;
      if (!handler) {
        ctx.output.writeLine(pc.yellow(t("repl.unknown_sub", { cmd: "provider", sub: subcmd })));
        ctx.output.writeLine(t("repl.provider_usage"));
        return;
      }
      await handler(args.slice(1));
    },
  });
  const listModels = async (): Promise<void> => {
    ctx.output.writeLine(`${t("repl.model_current")}  ${ctx.config.model}`);

    const { OpenAICompatProvider } = await import("../llm/openai-compat");
    const provider = new OpenAICompatProvider({
      model: ctx.config.model,
      baseUrl: ctx.config.provider.baseUrl,
      apiKey: ctx.config.provider.apiKey,
      contextWindow: ctx.config.contextWindow,
    });

    const { Spinner } = await import("../ui/spinner");
    const s = new Spinner({ channel: ctx.output });
    s.start(t("cli.fetching_models"));
    try {
      const models = await provider.listModels();
      s.stop();
      if (models.length > 0) {
        ctx.refreshModelCache();
        ctx.output.writeLine(t("cli.available_models"));
        const { getCertMark } = await import("../modules/certification/manifest");
        for (const m of models) {
          const marker = m === ctx.config.model ? pc.green("* ") : "  ";
          const mark = getCertMark(m, ctx.config.provider.baseUrl, version, process.cwd());
          const cert =
            mark === "certified" ? pc.green("✔") : mark === "stale" ? pc.yellow("○") : pc.dim("·");
          const label =
            mark === "certified"
              ? `  ${pc.green(t("cli.cert_label"))}`
              : mark === "stale"
                ? `  ${pc.yellow(t("cli.cert_stale_label"))}`
                : "";
          ctx.output.writeLine(` ${marker}${cert} ${m}${label}`);
        }
      } else {
        ctx.output.writeLine(t("cli.no_models_found"));
      }
    } catch (err) {
      s.stop();
      ctx.output.writeLine(t("cli.model_fetch_failed", { error: String(err) }), "stderr");
    }

    ctx.output.writeLine(t("cli.model_hint"));
  };

  const useModel = async (args: string[]): Promise<void> => {
    const name = args[0];
    if (!name) {
      ctx.output.writeLine(t("repl.model_usage"));
      return;
    }
    const result = await mutateConfig(ctx, "model", name);
    if (!result.ok) {
      renderConfigError(ctx, result);
      return;
    }
    ctx.output.writeLine(pc.green(t("repl.model_set", { name })));
    const known = ctx.knownModels();
    if (known.length > 0 && !known.includes(name)) {
      ctx.output.writeLine(pc.yellow(t("model.not_in_list", { name })));
    }
    reportSaved(ctx, result);
  };

  const modelHandlers: Record<string, (args: string[]) => void | Promise<void>> = {
    list: listModels,
    use: useModel,
  };

  ctx.registerCommand({
    name: "model",
    description: t("repl.model_list"),
    usage: t("repl.model_usage"),
    examples: ["/model list", "/model use qwen/qwen3.5-9b"],
    action: async (args: string[]) => {
      const subcmd = args[0];
      const handler = subcmd ? modelHandlers[subcmd] : modelHandlers.list;
      if (!handler) {
        ctx.output.writeLine(pc.yellow(t("repl.unknown_sub", { cmd: "model", sub: subcmd })));
        ctx.output.writeLine(t("repl.model_usage"));
        return;
      }
      await handler(args.slice(1));
    },
  });
  ctx.registerCommand({
    name: "context",
    description: t("cli.manage_context"),
    usage: t("repl.context_usage"),
    examples: ["/context", "/context 64000", "/context system 10%", "/context reserve 0.2"],
    action: async (args: string[]) => {
      if (args.length === 0) {
        for (const line of budgetBreakdownLines(ctx.config)) ctx.output.writeLine(line);
        ctx.output.writeLine(pc.dim(t("repl.context_usage")));
        return;
      }

      if (args[0] === "system" || args[0] === "reserve") {
        const raw = args[1];
        if (!raw) {
          ctx.output.writeLine(t("repl.context_usage"));
          return;
        }
        const key =
          args[0] === "system"
            ? "contextBudget.systemPrompt"
            : "contextBudget.responseReserve";
        const result = await mutateConfig(ctx, key, raw);
        if (!result.ok) {
          renderConfigError(ctx, result);
          return;
        }
        ctx.output.writeLine(
          pc.green(t("cli.context_fraction_set", { key: args[0], value: result.display })),
        );
        return;
      }

      if (!/^\d+$/.test(args[0])) {
        ctx.output.writeLine(pc.yellow(t("context.unknown_arg", { arg: args[0] })));
        ctx.output.writeLine(t("repl.context_usage"));
        return;
      }
      const result = await mutateConfig(ctx, "contextWindow", args[0]);
      if (!result.ok) {
        renderConfigError(ctx, result);
        return;
      }
      ctx.output.writeLine(pc.green(t("cli.context_set", { size: String(result.value) })));
      reportSaved(ctx, result);
    },
  });
}

function registerAgentCommands(ctx: ReplContext): void {
  const securityStatus = (): void => {
    const s = ctx.config.security;
    const flag = (v?: boolean) => (v ? t("reasoning.on") : t("reasoning.off"));
    const sep = pc.dim(" · ");
    ctx.output.writeLine(`security${sep}${flag(s?.enabled)}`);
    ctx.output.writeLine(
      `↳ bash ${flag(s?.bash.enabled)}${sep}paths ${flag(s?.paths.enabled)}${sep}network ${flag(s?.network.enabled)}`,
    );
    ctx.output.writeLine(
      `↳ contentScan ${flag(s?.contentScan.enabled)}${sep}encryption ${flag(s?.sessionEncryption.enabled)}`,
    );
  };

  const securityHandlers: Record<string, () => void> = {
    status: securityStatus,
  };

  ctx.registerCommand({
    name: "security",
    description: t("repl.security"),
    action: (args: string[]) => {
      const sub = args[0]?.trim().toLowerCase();
      const handler = sub ? securityHandlers[sub] : securityHandlers.status;
      if (!handler) {
        ctx.output.writeLine(pc.yellow(t("repl.unknown_sub", { cmd: "security", sub })));
        return;
      }
      handler();
    },
  });
  ctx.registerCommand({
    name: "reload",
    description: t("repl.reload"),
    usage: t("repl.reload_usage"),
    action: async () => {
      ctx.output.writeLine(pc.yellow(t("repl.reloading")));
      await ctx.reload();
      ctx.output.writeLine(pc.green(t("repl.reloaded")));
      ctx.output.writeLine(`${t("repl.model")}       ${ctx.config.model}`);
      ctx.output.writeLine(`${t("repl.context")}     ${ctx.config.contextWindow}`);
      ctx.output.writeLine(
        `${t("repl.provider")}    ${ctx.config.provider.type} @ ${ctx.config.provider.baseUrl}`,
      );
    },
  });
  ctx.registerCommand({
    name: "plugins",
    description: t("repl.plugins"),
    usage: t("repl.plugins_usage"),
    action: (args: string[]) => {
      if (!ctx.pluginManager) {
        ctx.output.writeLine(t("cli.plugins.none"));
        return;
      }
      const showAll = args.includes("--all");
      const infos = ctx.pluginManager.getPluginInfos();
      const filtered = showAll ? infos : infos.filter(({ plugin }) => !plugin.isBuiltin);
      if (filtered.length === 0) {
        ctx.output.writeLine(t("cli.plugins.none"));
        return;
      }
      const mmaVersion = version;
      ctx.output.writeLine(
        t("cli.plugins.header", {
          count: String(filtered.length),
          mma: mmaVersion,
        }),
      );
      for (const { plugin, source } of filtered) {
        const v = plugin.version || "-";
        const origin = source || "builtin";
        const mark = plugin.isBuiltin ? t("cli.plugins.builtin_mark") : " ";
        ctx.output.writeLine(`  ${mark} ${plugin.name}  v${v}  [${origin}]`);
      }
      if (!showAll) {
        const builtinCount = infos.filter(({ plugin }) => plugin.isBuiltin).length;
        if (builtinCount > 0) {
          ctx.output.writeLine(
            pc.dim(`  ${t("repl.plugins_hidden", { count: String(builtinCount) })}`),
          );
        }
      }
    },
  });
}


function registerMmaCommands(ctx: ReplContext): void {
  registerRunCommands(ctx);
  registerConfigCommands(ctx);
  registerProviderCommands(ctx);
  registerAgentCommands(ctx);
  registerLspCommands(ctx);
}

function registerSessionCommands(ctx: ReplContext): void {
  if (!ctx.sessionManager) return;

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
        ctx.output.writeLine(t(dry ? "session.prune_dry" : "session.pruned", { n: candidates.length }));
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
        s.updatedAt.slice(0, 19).replace("T", " "),
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
      ctx.output.writeLine(`${t("session.deleted", { id: match.id })}: ${match.name}`);
    },
  });

  ctx.registerCommand({
    name: "export",
    description: t("repl.export"),
    usage: t("repl.export_usage"),
    examples: [
      "/export",
      "/export my-session --format md",
      "/export --format json --out -",
    ],
    action: async (args: string[]) => {
      let format: ExportFormat = "md";
      let out: string | undefined;
      let redact = true;
      let compact = false;
      const positional: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--format") {
          const v = args[++i];
          if (!v) {
            ctx.output.writeLine(t("export.missing_value", { flag: a }));
            return;
          }
          format = v as ExportFormat;
        } else if (a === "--out") {
          const v = args[++i];
          if (v === undefined) {
            ctx.output.writeLine(t("export.missing_value", { flag: a }));
            return;
          }
          out = v;
        } else if (a === "--no-redact") {
          redact = false;
        } else if (a === "--compact") {
          compact = true;
        } else {
          positional.push(a);
        }
      }
      if (format !== "md" && format !== "json" && format !== "jsonl") {
        ctx.output.writeLine(pc.yellow(t("export.invalid_format", { format })), "stderr");
        return;
      }
      const query = positional.join(" ");
      const sessions = ctx.sessionManager!.list();
      const match = query
        ? sessions.find(
            (s) =>
              s.id === query ||
              s.id.startsWith(query) ||
              s.name.toLowerCase().includes(query.toLowerCase()),
          )
        : sessions.find((s) => s.id === ctx.sessionManager!.getActive());
      if (!match) {
        ctx.output.writeLine(
          query ? t("session.no_match", { query }) : t("session.no_active"),
        );
        return;
      }
      const messages = ctx.sessionManager!.getHistory(match.id);
      const log = ctx.sessionManager!.loadSessionLog(match.id);
      if (format === "jsonl" ? log.length === 0 : messages.length === 0) {
        ctx.output.writeLine(pc.yellow(t("export.empty")));
        return;
      }
      const text = redactExport(
        formatExport({ meta: match, messages, log }, format, { compact }),
        redact,
      );
      if (out === "-") {
        ctx.output.writeLine(text);
        return;
      }
      const baseDir = out ? dirname(out) : globalExportsDir();
      const path =
        out ?? join(baseDir, `${sanitizeFileName(match.name)}-${match.id.slice(0, 8)}.${extensionFor(format)}`);
      try {
        mkdirSync(baseDir, { recursive: true });
        writeFileSync(path, text, "utf-8");
      } catch (e) {
        ctx.output.writeLine(pc.red(t("export.write_failed", { error: errMsg(e) })), "stderr");
        return;
      }
      ctx.output.writeLine(pc.green(t("export.written", { path })));
      ctx.output.writeLine(pc.dim(redact ? t("export.redacted") : t("export.raw")));
    },
  });
}


async function runConfigMigrate(ctx: ReplContext): Promise<void> {
  const { hasDomainFiles } = await import("../config/domains");
  const { loadConfig: loadCfg } = await import("../config/config");
  const configDir = ctx.configDir;
  const configPath = join(configDir, "config.json");

  if (hasDomainFiles(configDir)) {
    ctx.output.writeLine(pc.yellow(t("config.migrate_no_legacy")));
    return;
  }

  if (!existsSync(configPath)) {
    ctx.output.writeLine(pc.yellow(t("config.migrate_no_legacy")));
    return;
  }

  ctx.output.writeLine(t("config.migrate_start"));

  const { config } = loadCfg({ configDir, projectConfigPath: join(configDir, ".mmrc") });
  saveConfig(config, configPath, configDir);

  const { renameSync, readdirSync } = await import("fs");
  renameSync(configPath, `${configPath}.bak`);

  const domainFiles = readdirSync(join(configDir, "config")).filter((f: string) =>
    f.endsWith(".json"),
  );
  ctx.output.writeLine(pc.green(t("config.migrate_done", { count: String(domainFiles.length) })));
}
