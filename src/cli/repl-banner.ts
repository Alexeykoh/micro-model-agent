/**
 * Стартовый баннер REPL: строки модели/провайдера/контекста/модулей, хинт про
 * legacy-конфиг, LSP-сводка и строка контекст-пробника.
 *
 * Вынесено из `repl.ts` (правило 6). Баннер печатается plain: кадр промпта
 * ещё не нарисован, поэтому стирать нечего.
 */
import { existsSync } from "fs";
import { join } from "path";
import { pc } from "../ui/colors";
import { t } from "../i18n/index";
import { divider } from "../ui/box";
import { activeProviderEndpoint } from "../modules/providers/manager";
import { probeLspServers } from "../modules/lsp/probe";
import { FileOnlyLogger } from "../modules/lsp/client";
import { DEFAULT_LSP_CONFIG } from "../modules/lsp/config";
import { projectMmaDir } from "../config/paths";
import type { Logger } from "../logger/app-logger";
import type { SessionLogger } from "../core/session-logger";
import type { Agent } from "../core/agent";
import type { AppConfig } from "../config/types";
import type { OutputChannel } from "../output";
import type { SessionManager } from "../modules/session/manager";
import type { SkillsModule } from "../modules/skills/module";
import type { PluginManager } from "../modules/plugins/manager";
import type { EnvironmentReport } from "../core/environment";
import type { ContextProbeResult } from "../llm/model-loader";

/** Поля `Repl`, нужные баннеру. */
export interface ReplBannerHost {
  config: AppConfig;
  agent: Agent;
  output: OutputChannel;
  baseDir: string;
  configDir: string;
  noAgentsMd: boolean;
  logger?: Logger;
  slog: SessionLogger;
  envReport?: EnvironmentReport;
  sessionManager?: SessionManager;
  skillsModule?: SkillsModule;
  pluginManager?: PluginManager;
}

/** Строки баннера (до печати): построчно, с переносом по ширине канала. */
export function bannerRows(host: ReplBannerHost): string[] {
  const info: string[] = [];
  const row = (label: string, value: string): void => {
    info.push(` ${pc.yellow(label)} ${value}`);
  };

  const ctx = host.config.contextWindow;
  const sysBudget = Math.floor(ctx * host.config.contextBudget.systemPrompt);
  const resBudget = Math.floor(ctx * host.config.contextBudget.responseReserve);
  const histBudget = ctx - sysBudget - resBudget;

  row(t("repl.model"), pc.white(host.config.model));
  // Плоские поля протухают после `/provider use` — истина в entries.
  const endpoint = activeProviderEndpoint(host.config.provider);
  row(t("repl.provider"), `${endpoint.type}  →  ${pc.dim(endpoint.baseUrl)}`);
  row(
    t("repl.context"),
    `${pc.white(String(ctx))}  ${pc.dim(`(${t("repl.ctx_part_system")}:${sysBudget}  ${t("repl.ctx_part_reserve")}:${resBudget}  ${t("repl.ctx_part_history")}:${histBudget})`)}`,
  );

  const si = host.agent.getSystemPromptInfo();
  row(
    t("repl.sysprompt_label"),
    pc.dim(t("repl.sysprompt_size", { used: si.tokenCount, budget: sysBudget })),
  );

  if (host.skillsModule) {
    const budget = host.skillsModule.getBudget();
    row(
      t("repl.skills_label"),
      t("repl.skills_available", {
        count: String(host.skillsModule.getAvailable().length),
        budget: String(budget.total),
      }),
    );
  }

  if (host.pluginManager) {
    const infos = host.pluginManager.getPluginInfos().filter(({ plugin }) => !plugin.isBuiltin);
    if (infos.length > 0) {
      const pluginNames = infos
        .map(({ plugin, source }) => {
          const version = plugin.version ? `${pc.dim(plugin.version)}` : "";
          const origin = source ? pc.dim(` [${source}]`) : "";
          return `${plugin.name}${version}${origin}`;
        })
        .join(", ");
      row(
        t("repl.plugins_label"),
        t("repl.plugins_active", { count: String(infos.length), names: pluginNames }),
      );
    }
  }

  const mcpServers = host.config.mcpServers || {};
  const enabledServers = Object.entries(mcpServers).filter(([, s]) => s.enabled !== false);
  if (enabledServers.length > 0) {
    const names = enabledServers.map(([name]) => name).join(", ");
    row(
      t("repl.mcp_label"),
      `${pc.white(String(enabledServers.length))}  ${pc.dim(`(${names})`)}`,
    );
  }

  // Показываем workspace агента (каталог `-d`), а не process cwd: `bun run`
  // ставит cwd в корень пакета, где агент НЕ работает.
  row(t("repl.work_dir"), pc.dim(host.baseDir));

  if (host.noAgentsMd) {
    row(t("repl.agents_label"), pc.red(t("repl.disabled")));
  } else {
    const agentsMdCandidates = [
      join(host.baseDir, "AGENTS.md"),
      join(projectMmaDir(host.baseDir), "AGENTS.md"),
      join(host.configDir, "AGENTS.md"),
    ];
    const foundAgents = agentsMdCandidates.filter((p) => existsSync(p));
    if (foundAgents.length > 0) {
      for (const p of foundAgents) {
        row(t("repl.agents_label"), pc.dim(p));
      }
    } else {
      row(t("repl.agents_label"), pc.dim(t("repl.not_found")));
    }
  }

  const meta = host.sessionManager?.getActiveMeta();
  if (meta) {
    const sessionPath = join(host.configDir, "sessions", meta.id);
    row(
      t("repl.session_label"),
      `${pc.cyan(meta.name)} ${pc.dim(`(${meta.id.slice(0, 12)})`)}  —  ${meta.messageCount} ${t("repl.msgs")}  ${pc.dim(sessionPath)}`,
    );
  }
  return info;
}

/** Печать баннера и завершающей пустой строки. */
export function printBanner(host: ReplBannerHost): void {
  for (const line of bannerRows(host)) {
    host.output.writeLine(pc.dim(line).trimEnd());
  }
  host.output.writeLine("");
}

/** Хинт про legacy-конфиг (best-effort: ошибка чтения его просто скипает). */
export async function printLegacyConfigHint(host: ReplBannerHost): Promise<void> {
  try {
    const { existsSync: exists } = await import("fs");
    const { join: pathJoin } = await import("path");
    const { hasDomainFiles } = await import("../config/domains");
    const legacyPath = pathJoin(host.configDir, "config.json");
    if (exists(legacyPath) && !hasDomainFiles(host.configDir)) {
      host.output.writeLine(pc.yellow(`  ${t("config.legacy_hint")}`));
      host.output.writeLine("");
    }
  } catch {
    // Хинт best-effort: ошибка чтения его просто скипает.
  }
}

/**
 * Пробнит LSP-серверы, применимые к текущему проекту, и форматирует однострочную
 * сводку баннера, напр. "✓ typescript (1.2s)" или "✗ css — timeout".
 * Null, если LSP выключен или серверов нет.
 */
export async function probeLspBanner(host: ReplBannerHost): Promise<string | null> {
  const config = host.config.lsp ?? DEFAULT_LSP_CONFIG;
  try {
    const lspOnlyLogger = host.logger ? new FileOnlyLogger(host.logger) : undefined;
    const summary = await probeLspServers(config, host.baseDir, { logger: lspOnlyLogger });
    // Результаты LSP-пробника — в сессию, для пост-мортем видимости.
    host.slog.logSessionStart({
      environment: host.envReport as unknown as Record<string, unknown>,
      lspProbe: {
        ok: summary.ok.map((r) => ({ language: r.language, durationMs: r.durationMs })),
        failed: summary.failed.map((r) => ({
          language: r.language,
          error: r.error,
          durationMs: r.durationMs,
        })),
        noneApplicable: summary.noneApplicable,
      },
    });
    if (summary.noneApplicable) return null;
    const parts: string[] = [];
    for (const r of summary.ok) {
      parts.push(pc.green(`✓ ${r.language}${pc.dim(` (${(r.durationMs / 1000).toFixed(1)}s)`)}`));
    }
    for (const r of summary.failed) {
      const reason = r.error?.includes("timeout") ? t("repl.lsp_timeout") : t("repl.lsp_failed");
      parts.push(pc.red(`✗ ${r.language}${pc.dim(` — ${reason}`)}`));
    }
    return parts.join("  ");
  } catch {
    return pc.yellow(t("repl.lsp_unknown"));
  }
}

/** Строка контекст-пробника (фон) или null, если расхождения нет. */
export function contextProbeLine(host: ReplBannerHost, probe: ContextProbeResult | null): string | null {
  if (!probe) return null;
  return probe.actual < host.config.contextWindow
    ? `${pc.yellow("⚠")} ${t("repl.context_probe_small", { model: probe.model, actual: probe.actual, configured: host.config.contextWindow })}`
    : probe.actual > host.config.contextWindow
      ? `${pc.dim(t("repl.context_probe_big", { model: probe.model, actual: probe.actual }))}`
      : null;
}

/** Печать фоновой строки поверх кадра (владелец строки промпта — канал). */
export function writeBannerLine(host: ReplBannerHost, line: string): void {
  host.output.writeLine(`${divider()}\n${line}`);
}
