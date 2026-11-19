// Встроенный `telegram-notify`: уведомление в Telegram о завершении хода.
// Порт пользовательского `~/.mma/plugins/telegram-notify.js` (v1.3.0):
// без захардкоженного токена — только свой файл настроек и env-оверрайд.
// Выключен по умолчанию (`DEFAULTS.plugins.disabled`), как `angular11`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalMmaDir, globalPluginsDir } from "../../../config/paths";
import type { AgentPlugin, PluginHookContext, TurnSummary } from "../../types";
import {
  TELEGRAM_NOTIFY_SCHEMA,
  telegramNotifySettings,
} from "./plugin-settings";
import {
  fetchJson,
  finalAssistantText,
  friendlyError,
  readGitBranch,
  resolveChatId,
  sendTelegramMessage,
  sessionEndMessage,
  turnMessage,
  type FetchJson,
  type SessionMeta,
  type TurnExtras,
} from "./telegram-notify-client";

/** Env-оверрайд (обратная совместимость с внешним плагином). */
function env(name: string): string {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/** Файл центрального кэша chat_id + разовый импорт легаси-файла. */
function chatIdCache(configDir: string): { read: () => string | null; write: (id: string) => void } {
  const central = join(configDir, "plugin-settings", "telegram-notify.chatid");
  const legacy = join(globalPluginsDir(), "telegram-notify.chatid");
  return {
    read: () => {
      for (const file of [central, legacy]) {
        try {
          const id = readFileSync(file, "utf8").trim();
          if (id) return id;
        } catch {
          /* нет файла — дальше */
        }
      }
      return null;
    },
    write: (id: string) => {
      try {
        writeFileSync(central, `${id}\n`, "utf8");
      } catch {
        /* best-effort: следующий ход разрешит chat_id заново */
      }
    },
  };
}

/** Провайдер и модель из конфига (для строки деталей, best-effort). */
function providerFromConfig(configDir: string): string | null {
  try {
    const cfg = JSON.parse(
      readFileSync(join(configDir, "config", "provider.json"), "utf8"),
    ) as { provider?: { type?: string; active?: string; entries?: Array<{ label?: string; type?: string }> } };
    const p = cfg.provider;
    if (!p) return null;
    const entry = p.active
      ? (p.entries ?? []).find((e) => e.label === p.active || e.type === p.active)
      : (p.entries ?? [])[0];
    return entry?.label || entry?.type || p.type || null;
  } catch {
    return null;
  }
}

/** Узкий логгер из хук-контекста (без каста через ToolContext). */
interface CtxLog {
  logger?: {
    debug?: (message: string) => void;
    warn?: (message: string) => void;
  };
}

/** Узкий доступ к истории контекста (без каста через ToolContext). */
interface CtxHistory {
  contextManager?: { getActiveHistory?: () => unknown };
}

export class TelegramNotifyPlugin implements AgentPlugin {
  name = "telegram-notify";
  version = "1.4.0";
  priority = 5;
  isBuiltin = true;
  author = "Alexe";
  description =
    "Telegram-уведомление: финальный ответ, ветка, провайдер, модель и причина ошибки.";
  permissions = ["network", "fs:read", "fs:write"] as AgentPlugin["permissions"];
  settingsSchema = TELEGRAM_NOTIFY_SCHEMA;

  private lastError: string | null = null;

  constructor(private readonly fetchImpl: FetchJson = fetchJson) {}

  onError(_ctx: PluginHookContext, error: Error): void {
    this.lastError = friendlyError(error?.message ?? error);
  }

  onTurnEnd(ctx: PluginHookContext, summary: TurnSummary): void {
    const tctx = ctx as CtxLog;
    const settings = telegramNotifySettings();
    const errText = summary && !summary.success && !summary.interrupted ? this.lastError : null;
    this.lastError = null;
    if (settings.notifyOn === "session") return;
    const meta = this.sessionMeta(ctx);
    if (!this.matchesFilter(settings, meta)) return;
    const token = this.token(settings);
    if (!token) {
      tctx.logger?.debug?.("[telegram-notify] no bot token — skipping");
      return;
    }
    const extras = this.collectExtras(ctx, meta);
    void this.send(tctx, token, turnMessage(meta, summary, extras, errText));
  }

  onSessionEnd(ctx: PluginHookContext): void {
    const tctx = ctx as CtxLog;
    const settings = telegramNotifySettings();
    if (settings.notifyOn !== "session" && settings.notifyOn !== "both") return;
    const meta = this.sessionMeta(ctx);
    if (!this.matchesFilter(settings, meta)) return;
    const token = this.token(settings);
    if (!token) {
      tctx.logger?.debug?.("[telegram-notify] no bot token — skipping");
      return;
    }
    const extras = this.collectExtras(ctx, meta);
    void this.send(tctx, token, sessionEndMessage(meta, extras));
  }

  private token(settings: { botToken: string }): string {
    return settings.botToken || env("MMA_TELEGRAM_BOT_TOKEN");
  }

  private sessionMeta(ctx: PluginHookContext): SessionMeta | null {
    const sm = (ctx as { sessionManager?: SessionMeta }).sessionManager;
    return sm ?? null;
  }

  private matchesFilter(
    settings: { sessionId: string; sessionName: string },
    meta: SessionMeta | null,
  ): boolean {
    const wantId = settings.sessionId || env("MMA_NOTIFY_SESSION_ID");
    const wantName = settings.sessionName || env("MMA_NOTIFY_SESSION_NAME");
    if (!wantId && !wantName) return true;
    const id = meta?.id != null ? String(meta.id) : "";
    const name = meta?.name != null ? String(meta.name) : "";
    if (wantId && id !== wantId) return false;
    if (wantName && name !== wantName) return false;
    return true;
  }

  private collectExtras(ctx: PluginHookContext, meta: SessionMeta | null): TurnExtras {
    const tctx = ctx as CtxHistory;
    const configDir = globalMmaDir();
    let history: unknown = null;
    try {
      history = tctx.contextManager?.getActiveHistory?.() ?? null;
    } catch {
      history = null;
    }
    const projectDir =
      meta?.projectDir != null ? String(meta.projectDir) : null;
    let model: string | null = null;
    try {
      const core = JSON.parse(
        readFileSync(join(configDir, "config", "core.json"), "utf8"),
      ) as { model?: unknown };
      if (typeof core.model === "string" && core.model) model = core.model;
    } catch {
      model = null;
    }
    return {
      branch: readGitBranch(projectDir),
      provider: providerFromConfig(configDir),
      model,
      text: finalAssistantText(history),
    };
  }

  private async send(tctx: CtxLog, token: string, text: string): Promise<void> {
    const logger = tctx.logger;
    try {
      const cache = chatIdCache(globalMmaDir());
      let chatId = cache.read();
      if (!chatId) {
        const resolved = await resolveChatId(this.fetchImpl, token, cache);
        if (!resolved) {
          throw new Error(
            "chat_id не найден: отправьте /start боту или задайте chatId в настройках",
          );
        }
        chatId = resolved;
      }
      await sendTelegramMessage(this.fetchImpl, token, chatId, text);
      logger?.debug?.("[telegram-notify] уведомление отправлено");
    } catch (err: unknown) {
      logger?.warn?.(`[telegram-notify] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Готовый инстанс для регистрации в bootstrap. */
export const plugin = new TelegramNotifyPlugin();
