// Модуль LSP: автопроверка после write/edit, тул lsp_check, отключение мёртвых серверов.
import type { AgentModule } from "../types";
import type { AgentPlugin } from "../types";
import type { ToolDefinition, ToolContext, ToolCall, ToolResult } from "../../tools/types";
import { existsSync } from "fs";
import { relative, resolve } from "path";
import { LspClient, type LspClientLogger } from "./client";
import { getServerForFile, DEFAULT_LSP_CONFIG } from "./config";
import { findProjectRoot } from "./project-root";
import { isPathInScope } from "../security/path-validator";
import { DEFAULT_SECURITY_CONFIG } from "../../config/security";
import { toForwardSlash } from "../../tools/path-utils";
import { safeResolvePath } from "../../tools/path-utils";
import { t } from "../../i18n/index";
import type { LspConfig, LspServerConfig, LspDiagnostic } from "./types";
import { severityLabels, collectCheckFiles, formatCheckDiagnostics } from "./check-tool";
import {
  diagnoseLspServers,
  classifyLspError,
  type LspDiagnoseDeps,
  type LspFailureReason,
} from "./diagnose";
import { errMsg } from "../../utils";
import { join } from "path";

/**
 * Подряд идущих падений LSP до отключения сервера на сессию. Мёртвый сервер
 * (не стоит, упала npx-автоустановка, нет пути) иначе спамит `[LSP check failed]`
 * на КАЖДУЮ запись, приучая модель игнорировать сигнал целиком (наблюдалось:
 * ses_mst2r0r5 — LSP мёртв всю сессию, модель не реагировала). После порога —
 * одно громкое сообщение и тишина по этому серверу: таймаут CSS не должен
 * ронять проверки TypeScript.
 */
const MAX_CONSECUTIVE_LSP_FAILURES = 3;

/**
 * Диагностики резолва модулей, бессмысленные без type-окружения. В голом
 * каталоге (без tsconfig.json / node_modules) TS-сервер рапортует
 * `Cannot find module 'fs'` и `Cannot find name '__dirname'` на валидный
 * Node-код — модель бросает рабочий подход из-за фантомных ошибок (наблюдалось
 * ses_mtho2oab: LSP-"ошибки" столкнули модель с планового .ts на .js и в
 * спираль plan-drift). Душатся с явной пометкой inconclusive, если рядом с
 * корнем проекта нет type-окружения.
 */
const TYPE_ENV_DIAG_PATTERN =
  /Cannot find module ['"][^'"]+['"] or its corresponding type declarations|Cannot find name '(__dirname|__filename|require|process|Buffer|console)'|Do you need to install type definitions/;

/** Ключи actionable-подсказок по классу причины сбоя LSP (одна строка модели). */
const LSP_HINT_KEYS: Partial<Record<LspFailureReason, string>> = {
  "binary-missing": "lsp.hint_binary_missing",
  offline: "lsp.hint_offline",
  network: "lsp.hint_network",
  timeout: "lsp.hint_timeout",
  "spawn-failed": "lsp.hint_spawn",
};

/** Подсказка под `[LSP check failed]` (пусто, если класса с действием нет). */
function failureHint(message: string, npxFallback: boolean): string {
  const key = LSP_HINT_KEYS[classifyLspError(message, { npxFallback })];
  return key ? `\n${t(key)}` : "";
}

function hasTypeEnvironment(projectRoot: string): boolean {
  return (
    existsSync(join(projectRoot, "tsconfig.json")) ||
    existsSync(join(projectRoot, "jsconfig.json")) ||
    existsSync(join(projectRoot, "node_modules"))
  );
}

/** Модуль LSP: пост-проверки записи, тул lsp_check, учёт мёртвых серверов. */
export class LspModule implements AgentModule {
  name = "lsp";
  private config: LspConfig;
  private client: LspClient;
  private failuresByServer = new Map<string, number>();
  private disabledServers = new Set<string>();
  private logger: LspClientLogger | null = null;

  constructor(config?: Partial<LspConfig>, client?: LspClient, logger?: LspClientLogger) {
    this.config = { ...DEFAULT_LSP_CONFIG, ...config };
    this.client = client ?? new LspClient();
    this.client.setOffline(this.config.offline);
    this.logger = logger ?? null;
    this.client.setLogger(this.logger);
  }

  /** Обновить логгер (напр. после смены сессии). */
  setLogger(logger: LspClientLogger | null): void {
    this.logger = logger;
    this.client.setLogger(logger);
  }

  /** Глобальный тумблер LSP (живьём; плагин читает `this.config.enabled`). */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    this.client.setOffline(this.config.offline);
  }

  /** Офлайн-режим живьём: не использовать npx (env `MMA_LSP_OFFLINE` сильнее). */
  setOffline(offline: boolean): void {
    this.config.offline = offline;
    this.client.setOffline(offline);
  }

  /** Текущие глобальные флаги для UI (`GET /api/lsp/doctor`, вкладка LSP). */
  getFlags(): { enabled: boolean; offline: boolean } {
    return { enabled: this.config.enabled !== false, offline: this.config.offline === true };
  }

  /** Сбросить отключённые серверы (напр. после /lsp restart). */
  resetDisabledServers(): void {
    this.failuresByServer.clear();
    this.disabledServers.clear();
  }

  /** Список отключённых ключей серверов. */
  getDisabledServers(): string[] {
    return Array.from(this.disabledServers);
  }

  /** Счётчики падений по серверам. */
  getFailureCounts(): Map<string, number> {
    return new Map(this.failuresByServer);
  }

  /**
   * Структурная диагностика серверов проекта (для `/lsp doctor`): применимость,
   * резолв запуска, реальная проба и класс причины. По умолчанию использует
   * собственный клиент и логгер модуля.
   */
  diagnose(baseDir: string, deps: LspDiagnoseDeps = {}) {
    return diagnoseLspServers(this.config, baseDir, {
      ...deps,
      client: deps.client ?? this.client,
      logger: deps.logger ?? this.logger ?? undefined,
    });
  }

  /** Тест-хук: отключал ли модуль какой-то LSP-сервер на сессии. */
  isLspDisabled(): boolean {
    return this.disabledServers.size > 0;
  }

  /** Тест-хук: отключён ли сервер (ключ из конфига). */
  isServerDisabled(key: string): boolean {
    return this.disabledServers.has(key);
  }

  /** Стабильная идентичность сервера из конфига. */
  private serverKey(server: LspServerConfig): string {
    return `${server.command}:${(server.args ?? []).join(" ")}`;
  }

  getPlugin(): AgentPlugin {
    return {
      name: "lsp-check",
      priority: 15,
      onAfterTool: async (_ctx: ToolContext, call: ToolCall, result: ToolResult) => {
        if (!this.config.enabled) return;
        if (call.name !== "write_file" && call.name !== "edit_file") return;
        if (!result.success) return;

        const filePath = String(call.arguments.path ?? "");
        if (!filePath) return;

        const fullPath = resolve(_ctx.baseDir, filePath);
        if (!existsSync(fullPath)) return;

        const serverConfig = getServerForFile(fullPath, this.config);
        if (!serverConfig) return;

        const key = this.serverKey(serverConfig);
        if (this.disabledServers.has(key)) return;

        const projectRoot = findProjectRoot(
          fullPath,
          _ctx.baseDir,
          serverConfig.workspaceMarkers ?? [],
        );

        try {
          const diagnostics = await this.client.checkFile(
            fullPath,
            _ctx.baseDir,
            serverConfig,
            projectRoot,
          );
          this.failuresByServer.set(key, 0);
          const errors = diagnostics.filter((d) => d.severity === 1);
          const warnings = diagnostics.filter((d) => d.severity === 2);

          if (errors.length > 0) {
            const items = formatDiagnostics(errors, fullPath);
            result.output += `\n\n[LSP errors]:\n${items}`;
          }
          if (warnings.length > 0) {
            const items = formatDiagnostics(warnings, fullPath);
            result.output += `\n\n[LSP warnings]:\n${items}`;
          }
        } catch (e) {
          // Падения — наружу, а не молчаливый []: мёртвый LSP раньше давал
          // НОЛЬ диагностик целыми сессиями, и модель находила ошибки типов
          // лишь реактивно через `bun run build`.
          const msg = errMsg(e);
          const failures = (this.failuresByServer.get(key) ?? 0) + 1;
          this.failuresByServer.set(key, failures);
          try {
            _ctx.logger?.warn(`LSP check failed for ${filePath}: ${msg}`);
          } catch {
            // Падающий логгер не должен ломать путь проверки.
          }
          if (failures >= MAX_CONSECUTIVE_LSP_FAILURES) {
            // Одно громкое actionable-сообщение, дальше — без шума на каждую
            // запись до конца сессии. Модель не должна учиться игнорить LSP.
            this.disabledServers.add(key);
            result.output += `\n\n[LSP disabled: ${t("lsp.unavailable")}]`;
          } else {
            result.output += `\n\n[LSP check failed]: ${msg}${failureHint(
              msg,
              serverConfig.command === "npx",
            )}`;
          }
        }
      },
    };
  }

  /**
   * Тул диагностики по требованию. Проверки LSP шли только после write/edit
   * (плагин выше), и read-only задача «проверь проект на ошибки» получала
   * НОЛЬ фидбэка от компилятора — модель сканировала файлы через read_file и
   * не узнавала, компилируется ли код (наблюдалось: ses_msvuao0h — задача
   * "проверь на ошибки" без build, без lsp, с декларацией успеха). `lsp_check`
   * даёт модели способ спросить статические диагностики по требованию.
   */
  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: "lsp_check",
        icon: "🩺",
        description:
          'Run static checks (LSP diagnostics) on a file or directory. For "check for errors" tasks: pass a file to check it, or a directory to check its source files (capped at 15). Returns [LSP errors] / [LSP warnings] for files with a configured LSP server.',
        tags: ["code", "check"],
        alwaysOn: true,
        boundedOutput: true,
        timeoutMs: 90000,
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "File or directory to check",
            },
          },
          required: ["path"],
        },
        handler: async (ctx, args) => this.runCheck(ctx, args),
      },
    ];
  }

  private async runCheck(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.config.enabled) {
      return { success: false, output: t("lsp.check_disabled") };
    }
    const path = String(args.path ?? "");
    if (!path) return { success: false, output: t("lsp.check_no_path") };

    const resolved = safeResolvePath(ctx.baseDir, path);
    const securityPaths = ctx.config?.security?.paths || DEFAULT_SECURITY_CONFIG.paths;
    const scopeCheck = isPathInScope(ctx.baseDir, resolved, ctx.scope, securityPaths);
    if (!scopeCheck.allowed) {
      return {
        success: false,
        output: t("file.path_not_allowed", {
          path: `${path} — ${scopeCheck.reason}`,
        }),
      };
    }
    if (!existsSync(resolved)) {
      return { success: false, output: t("lsp.check_notfound", { path }) };
    }

    const files = await collectCheckFiles(resolved, this.config);
    const errors: Array<{ file: string; diag: LspDiagnostic }> = [];
    const warnings: Array<{ file: string; diag: LspDiagnostic }> = [];
    const notes: string[] = [];
    const checkedFiles: string[] = [];
    let checked = 0;
    let suppressedTypeEnvDiags = 0;

    for (const file of files) {
      const serverConfig = getServerForFile(file, this.config);
      if (!serverConfig) continue;
      const key = this.serverKey(serverConfig);
      if (this.disabledServers.has(key)) continue;
      const projectRoot = findProjectRoot(file, ctx.baseDir, serverConfig.workspaceMarkers ?? []);
      try {
        let diags = await this.client.checkFile(file, ctx.baseDir, serverConfig, projectRoot);
        this.failuresByServer.set(key, 0);
        checked++;
        checkedFiles.push(toForwardSlash(relative(ctx.baseDir, file)));
        if (!hasTypeEnvironment(projectRoot)) {
          const kept = diags.filter((d) => {
            if (TYPE_ENV_DIAG_PATTERN.test(d.message)) {
              suppressedTypeEnvDiags++;
              return false;
            }
            return true;
          });
          diags = kept;
        }
        for (const d of diags) {
          if (d.severity === 1) errors.push({ file, diag: d });
          else if (d.severity === 2) warnings.push({ file, diag: d });
        }
      } catch (e) {
        const msg = errMsg(e);
        const failures = (this.failuresByServer.get(key) ?? 0) + 1;
        this.failuresByServer.set(key, failures);
        try {
          ctx.logger?.warn(`LSP check failed for ${file}: ${msg}`);
        } catch {
          // Падающий логгер не должен ломать путь проверки.
        }
        if (failures >= MAX_CONSECUTIVE_LSP_FAILURES) {
          this.disabledServers.add(key);
          notes.push(`[LSP disabled: ${t("lsp.unavailable")}]`);
        } else {
          notes.push(
            `[LSP check failed for ${file}: ${msg}]${failureHint(
              msg,
              serverConfig.command === "npx",
            )}`,
          );
        }
      }
    }

    const lines: string[] = [];
    if (checked > 0) {
      lines.push(t("lsp.checked_files", { count: String(checked) }));
      lines.push(...checkedFiles.map((f) => `  ${f}`));
    }
    if (errors.length > 0) {
      lines.push(`[LSP errors] (${errors.length}):`);
      lines.push(formatCheckDiagnostics(errors, ctx.baseDir));
    }
    if (warnings.length > 0) {
      lines.push(`[LSP warnings] (${warnings.length}):`);
      lines.push(formatCheckDiagnostics(warnings, ctx.baseDir));
    }
    if (checked > 0 && errors.length === 0 && warnings.length === 0) {
      lines.push(t("lsp.check_clean", { count: String(checked) }));
    }
    if (suppressedTypeEnvDiags > 0) {
      lines.push(
        `[lsp_check inconclusive: no tsconfig.json / node_modules near project root — ${suppressedTypeEnvDiags} module-resolution diagnostic(s) suppressed. Initialize the project (package.json + types) for accurate TypeScript checks.]`,
      );
    }
    lines.push(...notes);
    if (lines.length === 0) {
      return {
        success: true,
        output: t("lsp.check_clean", { count: String(checked) }),
      };
    }
    return { success: errors.length === 0, output: lines.join("\n") };
  }
}

function formatDiagnostics(diagnostics: LspDiagnostic[], filePath: string): string {
  const filename = toForwardSlash(filePath).split("/").pop() ?? filePath;
  return diagnostics
    .slice(0, 5)
    .map((d) => {
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const sev = severityLabels[d.severity] ?? "unknown";
      return `  ${filename}(${line},${col}): ${sev}: ${d.message}`;
    })
    .join("\n");
}
