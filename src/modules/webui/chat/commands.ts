// Диспатч слеш-команд `mma web`: карта хендлеров на той же механике, что REPL.
/**
 * Путь `/` в браузере был документированным no-op. Модуль гоняет поддерживаемое
 * подмножество через карту хендлеров (правило архитектуры #17 — без `if`-цепочки)
 * и переиспользует ТУ ЖЕ механику, что REPL: реестр конфига
 * (`getConfigValue`/`setConfigValue`), хуки `saveConfig`/`reconfigure` хоста,
 * shared стор памяти. Вывод — построчно по SSE событием `command`, в ленте дим.
 *
 * Терминальные команды (`/meet`, интерактивные промпты, `/wizard`) сознательно
 * вне скоупа — поддерживаемое подмножество см. в `HELP`.
 */
import type { AppConfig } from "../../../config/types";
import { t } from "../../../i18n/index";
import { canonicalKeys, getConfigValue } from "../../../config/registry";
import { redactContextSecrets } from "../../../core/api";
import { errMsg } from "../../../utils/error";
import { memoryLines } from "./memory-commands";
import { makeSettingsHandlers } from "../settings/commands-settings";
import { activeMeta, applyConfigWrite, withConfig, type Handler, type Out } from "./commands-shared";
import { appendCommandLog } from "./command-log";
import { broadcast, type SessionStore, type ConfigStore, type WorkspaceStore, type SseTransport, type RuntimeState } from "../state";

/**
 * Поддерживаемое подмножество для `/help` (по строке). Описания — ключи i18n
 * (`web.command.*`), резолвятся в момент эмита, чтобы `/help` и
 * `GET /api/commands` шли за серверной локалью.
 */
const HELP: Array<{ usage: string; descKey: string }> = [
  { usage: "/help", descKey: "web.command.help" },
  { usage: "/status", descKey: "web.command.status" },
  { usage: "/config <key> [value]", descKey: "web.command.config" },
  { usage: "/model list | /model use <name>", descKey: "web.command.model" },
  { usage: "/provider list | /provider use <name>", descKey: "web.command.provider" },
  { usage: "/reasoning [show|hide|on|off|level <lvl>]", descKey: "web.command.reasoning" },
  { usage: "/verbose <quiet|normal|verbose>", descKey: "web.command.verbose" },
  { usage: "/context [<tokens>]", descKey: "web.command.context" },
  { usage: "/security [status|<key> [value]]", descKey: "web.command.security" },
  { usage: "/session list | /session use <id>", descKey: "web.command.session" },
  { usage: "/export [md|json|jsonl]", descKey: "web.command.export" },
  { usage: "/memory [get|set|unset|find|forget]", descKey: "web.command.memory" },
  { usage: "/clear", descKey: "web.command.clear" },
  { usage: "/new", descKey: "web.command.new" },
];

/** Пейлоад `GET /api/commands`: имя + usage + описание на команду. */
export function webCommandList(): Array<{ name: string; usage: string; desc: string }> {
  return HELP.map((h) => ({
    name: h.usage.slice(1).split(/[\s|]/)[0],
    usage: h.usage,
    desc: t(h.descKey),
  }));
}

/** Входы диспатчера: состояние и sink захвата (для тестов). */
export interface WebCommandDeps {
  state: SessionStore & ConfigStore & WorkspaceStore & SseTransport & RuntimeState;
  /** Sink захвата для тестов; дефолт — SSE-бродкаст `command`. */
  emit?: (text: string) => void;
}

/** Строит диспатчер `(line) => Promise<void>`, ввязанный в `WebHost`. */
export function makeWebCommands(deps: WebCommandDeps): (line: string) => Promise<void> {
  const { state } = deps;
  const raw =
    deps.emit ??
    ((text: string) =>
      // Событие несёт владельца-сессию: команда из фоновой вкладки должна
      // попасть в её ленту, а не в активную (аудит §6.10).
      broadcast(
        { type: "command", ts: Date.now(), text, sessionId: state.activeSessionId ?? undefined },
        state,
      ));
  // Каждая эмитимая строка — через точечную редактуру: чтения конфига могут
  // эхом вернуть только что заданный ключ, а лента видна пользователю.
  const out: Out = (text) => raw(redactContextSecrets(text));

  const handlers: Record<string, Handler> = {
    help: (_args, o) => HELP.forEach((h) => o(`${h.usage}  ·  ${t(h.descKey)}`)),
    status: (_args, o) => withConfig(state, o, (cfg) => status(cfg, state, o)),
    config: (args, o) => withConfig(state, o, (cfg) => configCmd(cfg, args, o, state)),
    model: (args, o) => withConfig(state, o, (cfg) => modelCmd(cfg, args, o, state)),
    provider: (args, o) => withConfig(state, o, (cfg) => providerCmd(cfg, args, o, state)),
    memory: (args, o) => memoryCmd(state, args, o),
    ...makeSettingsHandlers(state),
  };

  return async (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/")) return;
    const parts = trimmed.slice(1).trim().split(/\s+/);
    const name = (parts.shift() ?? "").toLowerCase();
    if (!name) return;
    // Capture what the user saw: one `command` record carries the line, the
    // outcome and a short result (B-35). Error lines use the `↳` convention.
    const result: string[] = [];
    const emit: Out = (text) => {
      result.push(text);
      out(text);
    };
    let ok = true;
    const handler = handlers[name];
    if (!handler) {
      ok = false;
      emit(`↳ unknown command: ${name}`);
    } else {
      try {
        await handler(parts, emit);
      } catch (err) {
        ok = false;
        emit(`↳ ${errMsg(err)}`);
      }
      if (result.some((text) => text.trimStart().startsWith("↳"))) ok = false;
    }
    appendCommandLog(state, trimmed, ok, result);
  };
}

/** Однострочный статус: модель · провайдер · контекст · сессия · verbosity (+ окружение). */
function status(cfg: AppConfig, state: SessionStore & ConfigStore & WorkspaceStore & SseTransport & RuntimeState, out: Out): void {
  const provider = cfg.provider.active ?? cfg.provider.type;
  const parts = [cfg.model, provider, `${cfg.contextWindow} tok`];
  const meta = activeMeta(state);
  if (meta) parts.push(`${meta.name} (${t("web.status.msgs", { count: meta.messageCount })})`);
  const verbosity = getConfigValue(cfg, "ui.verbosity");
  parts.push(verbosity.ok ? verbosity.display : "-");
  out(parts.join(" · "));
  if (state.workspace) out(t("web.status.dir", { path: state.workspace }));
  if (state.agentsMd) {
    if (state.agentsMd.disabled) out(t("web.status.agents_disabled"));
    else if (state.agentsMd.files.length) out(`AGENTS.md: ${state.agentsMd.files.join(", ")}`);
    else out(t("web.status.agents_missing"));
  }
  if (state.projectMapStats) {
    const map = state.projectMapStats();
    out(
      map
        ? t("web.status.map", { files: map.files, symbols: map.symbols, tokens: map.tokens })
        : t("web.status.map_missing"),
    );
  }
}

/** `/config`: без аргументов — весь реестр, с ключом — чтение, с ключом+значением — запись. */
async function configCmd(
  cfg: AppConfig,
  args: string[],
  out: Out,
  state: SessionStore & ConfigStore & WorkspaceStore & SseTransport & RuntimeState,
): Promise<void> {
  if (args.length === 0) {
    for (const key of canonicalKeys()) {
      const r = getConfigValue(cfg, key);
      if (r.ok) out(`${key} = ${r.display}`);
    }
    return;
  }
  const [key, ...rest] = args;
  if (rest.length === 0) {
    const r = getConfigValue(cfg, key);
    out(r.ok ? `${r.key} = ${r.display}` : t("web.config.unknown_key", { key }));
    return;
  }
  await applyConfigWrite(cfg, key, rest.join(" "), out, state);
}

async function modelCmd(
  cfg: AppConfig,
  args: string[],
  out: Out,
  state: SessionStore & ConfigStore & WorkspaceStore & SseTransport & RuntimeState,
): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === "list") {
    out(`current: ${cfg.model}`);
    const models = state.knownModels?.() ?? [];
    if (models.length === 0) {
      out("↳ no models reported by provider");
      return;
    }
    for (const m of models) out(`${m === cfg.model ? "* " : "  "}${m}`);
    return;
  }
  if (sub === "use") {
    const name = rest[0];
    if (!name) {
      out("usage: /model use <name>");
      return;
    }
    await applyConfigWrite(cfg, "model", name, out, state);
    return;
  }
  out(`↳ unknown subcommand: model ${sub}`);
}

async function providerCmd(
  cfg: AppConfig,
  args: string[],
  out: Out,
  state: SessionStore & ConfigStore & WorkspaceStore & SseTransport & RuntimeState,
): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === "list") {
    const active = cfg.provider.active ?? cfg.provider.type;
    const entries = cfg.provider.entries?.length
      ? cfg.provider.entries
      : [{ type: cfg.provider.type, label: active }];
    for (const e of entries) {
      const name = e.label ?? e.type;
      out(`${name === active ? "* " : "  "}${name} (${e.type})`);
    }
    return;
  }
  if (sub === "use") {
    const name = rest[0];
    if (!name) {
      out("usage: /provider use <name>");
      return;
    }
    await applyConfigWrite(cfg, "provider.active", name, out, state);
    return;
  }
  out(`↳ unknown subcommand: provider ${sub}`);
}

function memoryCmd(state: SessionStore & ConfigStore & WorkspaceStore & SseTransport & RuntimeState, args: string[], out: Out): void {
  if (!state.memory) {
    out("↳ memory unavailable");
    return;
  }
  for (const line of memoryLines(state.memory, args)) out(line);
}
