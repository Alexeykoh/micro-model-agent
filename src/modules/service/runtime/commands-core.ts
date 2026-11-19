/**
 * Серверные хендлеры конфигурации и состояния агента (split W12):
 * help/status/config/model/provider/context/reasoning/verbose/security.
 *
 * Операции записи идут через общий `applyConfigWrite` (те же эффекты, что у
 * web/CLI), поэтому `/config model` и `POST /v1/host/config` не расходятся.
 */
import { t } from "../../../i18n/index";
import { DEFAULTS } from "../../../config/defaults";
import { budgetBreakdownLines } from "../../../config/budget";
import {
  canonicalKeys,
  getConfigValue,
  resolveConfigKey,
} from "../../../config/registry";
import { applyConfigWrite } from "../../../runtime/config-write";
import { buildCommandCatalog } from "../../../core/commands/spec";
import { isAvailable } from "../../../core/commands/catalog";
import { resolveVerbosity } from "../../../ui/theme";
import { hostStateOf } from "./host-state";
import type { HostCommandResult } from "../../../core/host";
import { fail, ok, type CommandCtx } from "./commands-types";

/** Ключи, которые можно менять во время хода (INV-T3). */
const BUSY_EXEMPT = new Set(["ui.theme", "ui.themeMode"]);

/** Запись ключа конфига с персистом и reconfigure. */
async function writeKey(ctx: CommandCtx, key: string, raw: string) {
  if (ctx.s.pool.anyBusy() && !BUSY_EXEMPT.has(key)) return fail(t("daemon.command_busy"));
  const result = await applyConfigWrite(ctx.s.config, key, raw, {
    saveConfig: ctx.s.deps.saveConfig,
    reconfigure: ctx.s.deps.reconfigure,
  });
  if (!result.ok) return fail(result.error ?? t("daemon.command_invalid_value"));
  if (key === "model" || key === "provider.active") void ctx.s.models.refresh();
  return ok(`${key}=${result.display ?? raw}`);
}

/** Дефолт ключа из `DEFAULTS` по его точечному пути. */
function defaultFor(key: string): string | null {
  let node: unknown = DEFAULTS;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[part];
    if (node === undefined) return null;
  }
  if (node === null || typeof node === "object") return JSON.stringify(node);
  return String(node);
}

/** `/help [команда]` — каталог и доступность на проводе. */
export function helpCommand(ctx: CommandCtx, args: string[]): HostCommandResult {
  const catalog = buildCommandCatalog();
  const requested = (args[0] ?? "").replace(/^\//, "").toLowerCase();
  if (requested) {
    const spec = catalog.find(
      (item) => item.name === requested || (item.aliases ?? []).includes(requested),
    );
    if (!spec) return ok(t("daemon.command_unknown", { name: requested }));
    return ok(
      `/${spec.name}${spec.usage ? ` ${spec.usage}` : ""}`,
      spec.description,
      ...(spec.examples ?? []).map((ex) => `  ${ex}`),
    );
  }
  const lines: string[] = [t("daemon.command_help_header")];
  for (const spec of catalog) {
    const markup = isAvailable(spec, "daemon") ? "" : ` ${t("daemon.command_terminal_mark")}`;
    lines.push(`/${spec.name}${markup}  ${spec.description}`);
  }
  return ok(...lines);
}

/** `/status` — модель/провайдер/контекст/сессия. */
export function statusCommand(ctx: CommandCtx): HostCommandResult {
  const state = hostStateOf(ctx.s, ctx.sessionId);
  const meta = ctx.s.deps.sessionManager?.get(ctx.sessionId);
  const parts = [state.model ?? ctx.s.config.model, state.provider ?? ctx.s.config.provider.type];
  if (meta) parts.push(`${meta.name} (${meta.messageCount} ${t("repl.msgs")})`);
  parts.push(`${ctx.s.config.contextWindow} tok`);
  parts.push(resolveVerbosity(ctx.s.config.ui));
  return ok(parts.join(" · "));
}

/** `/config [get key | set key value | key [value] | reset key]`. */
export async function configCommand(
  ctx: CommandCtx,
  args: string[],
): Promise<HostCommandResult> {
  const [first, second, ...rest] = args;
  if (!first) {
    const lines = canonicalKeys().map((key) => {
      const value = getConfigValue(ctx.s.config, key);
      return `${key} = ${value.ok ? value.display : "—"}`;
    });
    return ok(...lines);
  }
  if (first === "reset") {
    if (!second) return fail(t("daemon.command_usage_config_reset"));
    const def = defaultFor(second);
    if (def === null) return fail(t("daemon.command_unknown_key", { key: second }));
    return writeKey(ctx, second, def);
  }
  const explicit = first === "get" || first === "set";
  const key = explicit ? second : first;
  const value = explicit ? rest.join(" ") : [second, ...rest].filter(Boolean).join(" ");
  if (!key) return fail(t("daemon.command_usage_config"));
  if (!value) {
    const current = getConfigValue(ctx.s.config, key);
    if (!current.ok) return fail(t("daemon.command_unknown_key", { key }));
    return ok(`${current.key}=${current.display}`);
  }
  return writeKey(ctx, key, value);
}

/** `/model [list | use <name>]`. */
export async function modelCommand(ctx: CommandCtx, args: string[]): Promise<HostCommandResult> {
  const [sub, ...rest] = args;
  if (!sub || sub === "list") {
    const models = ctx.s.models.get();
    return ok(
      `current: ${ctx.s.config.model}`,
      ...(models.length ? models.map((m) => `${m === ctx.s.config.model ? "* " : "  "}${m}`) : [t("daemon.command_no_models")]),
    );
  }
  if (sub === "use") {
    const name = rest[0];
    if (!name) return ok(t("daemon.command_usage_model"));
    return writeKey(ctx, "model", name);
  }
  return ok(t("daemon.command_usage_model"));
}

/** `/provider [list | use <name>]`. */
export async function providerCommand(ctx: CommandCtx, args: string[]): Promise<HostCommandResult> {
  const [sub, ...rest] = args;
  const active = ctx.s.config.provider.active ?? ctx.s.config.provider.type;
  if (!sub || sub === "list") {
    const entries = ctx.s.config.provider.entries?.length
      ? ctx.s.config.provider.entries
      : [{ type: ctx.s.config.provider.type, label: active }];
    return ok(
      ...entries.map((entry) => {
        const name = entry.label ?? entry.type;
        return `${name === active ? "* " : "  "}${name} (${entry.type})`;
      }),
    );
  }
  if (sub === "use") {
    const name = rest[0];
    if (!name) return ok(t("daemon.command_usage_provider"));
    return writeKey(ctx, "provider.active", name);
  }
  return ok(t("daemon.command_usage_provider"));
}

/** `/context [<tokens> | system <v> | reserve <v>]`. */
export async function contextCommand(
  ctx: CommandCtx,
  args: string[],
): Promise<HostCommandResult> {
  if (args.length === 0) return ok(...budgetBreakdownLines(ctx.s.config));
  const [sub, raw] = args;
  if (sub === "system" || sub === "reserve") {
    if (!raw) return fail(t("repl.context_usage"));
    const key = sub === "system" ? "contextBudget.systemPrompt" : "contextBudget.responseReserve";
    return writeKey(ctx, key, raw);
  }
  return writeKey(ctx, "contextWindow", sub);
}

/** `/reasoning [show|hide|on|off|level <lvl>]`. */
export async function reasoningCommand(
  ctx: CommandCtx,
  args: string[],
): Promise<HostCommandResult> {
  const sub = (args[0] ?? "").trim().toLowerCase();
  if (!sub) {
    return ok(
      `reasoning: ${ctx.s.config.reasoning?.mode ?? "auto"}`,
      `display: ${ctx.s.config.showReasoning ? "on" : "off"}`,
    );
  }
  if (sub === "show" || sub === "on" || sub === "hide" || sub === "off") {
    return writeKey(ctx, "showReasoning", sub === "show" || sub === "on" ? "on" : "off");
  }
  if (sub === "level") {
    const level = args[1];
    if (!level) return fail(t("repl.reasoning_usage"));
    return writeKey(ctx, "reasoning.mode", level);
  }
  return fail(t("daemon.command_usage_reasoning"));
}

/** `/verbose [quiet|normal|verbose]`. */
export async function verboseCommand(
  ctx: CommandCtx,
  args: string[],
): Promise<HostCommandResult> {
  if (!args[0]) return ok(`verbosity: ${resolveVerbosity(ctx.s.config.ui)}`);
  return writeKey(ctx, "ui.verbosity", args[0]);
}

/** `/security [status]`. */
export function securityCommand(ctx: CommandCtx, args: string[]): HostCommandResult {
  const sub = (args[0] ?? "status").trim().toLowerCase();
  if (sub !== "status") return fail(t("daemon.command_usage_security"));
  const s = ctx.s.config.security;
  const flag = (v?: boolean) => (v ? "on" : "off");
  return ok(
    `security · ${flag(s?.enabled)}`,
    `↳ bash ${flag(s?.bash.enabled)} · paths ${flag(s?.paths.enabled)} · network ${flag(s?.network.enabled)}`,
    `↳ contentScan ${flag(s?.contentScan.enabled)} · encryption ${flag(s?.sessionEncryption.enabled)}`,
  );
}

/** Есть ли ключ в реестре (для honest-ошибок). */
export function knownKey(key: string): boolean {
  return resolveConfigKey(key) !== null;
}
