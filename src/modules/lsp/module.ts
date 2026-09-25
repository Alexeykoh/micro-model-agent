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
import { errMsg } from "../../utils";
import { join } from "path";

/**
 * Consecutive LSP failures before a server is disabled for the session. A dead
 * server (not installed, npx auto-install failed, path missing) otherwise
 * spams `[LSP check failed]` on EVERY write, teaching the model to ignore the
 * signal entirely (observed: ses_mst2r0r5 had LSP dead all session and the
 * model never reacted). After the threshold we say so once and stop the noise
 * for that server — a CSS timeout must not take TypeScript checks down too.
 */
const MAX_CONSECUTIVE_LSP_FAILURES = 3;

/**
 * Module-resolution diagnostics that are meaningless without a type
 * environment. In a bare directory (no tsconfig.json / node_modules) the
 * TypeScript server reports `Cannot find module 'fs'` and
 * `Cannot find name '__dirname'` for perfectly valid Node code — the model
 * then abandons a working approach because of phantom errors (observed
 * ses_mtho2oab: LSP "errors" pushed the model off a planned .ts file to .js
 * and into a plan-drift spiral). Suppressed with an explicit inconclusive
 * note when no type env exists near the project root.
 */
const TYPE_ENV_DIAG_PATTERN =
  /Cannot find module ['"][^'"]+['"] or its corresponding type declarations|Cannot find name '(__dirname|__filename|require|process|Buffer|console)'|Do you need to install type definitions/;

function hasTypeEnvironment(projectRoot: string): boolean {
  return (
    existsSync(join(projectRoot, "tsconfig.json")) ||
    existsSync(join(projectRoot, "jsconfig.json")) ||
    existsSync(join(projectRoot, "node_modules"))
  );
}

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
    this.logger = logger ?? null;
    this.client.setLogger(this.logger);
  }

  /** Update the logger (e.g., after session switch). */
  setLogger(logger: LspClientLogger | null): void {
    this.logger = logger;
    this.client.setLogger(logger);
  }

  /** Reset disabled servers (e.g., after /lsp restart). */
  resetDisabledServers(): void {
    this.failuresByServer.clear();
    this.disabledServers.clear();
  }

  /** Get list of disabled server keys. */
  getDisabledServers(): string[] {
    return Array.from(this.disabledServers);
  }

  /** Get failure counts per server. */
  getFailureCounts(): Map<string, number> {
    return new Map(this.failuresByServer);
  }

  /** Test hook: has the module disabled any LSP server for the session? */
  isLspDisabled(): boolean {
    return this.disabledServers.size > 0;
  }

  /** Test hook: is the given server (config-derived key) disabled? */
  isServerDisabled(key: string): boolean {
    return this.disabledServers.has(key);
  }

  /** Stable server identity derived from the config. */
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
          // Surface failures instead of silently returning [] — a dead LSP
          // previously produced ZERO diagnostics across whole sessions and the
          // model only found type errors reactively via `bun run build`.
          const msg = errMsg(e);
          const failures = (this.failuresByServer.get(key) ?? 0) + 1;
          this.failuresByServer.set(key, failures);
          try {
            _ctx.logger?.warn(`LSP check failed for ${filePath}: ${msg}`);
          } catch {}
          if (failures >= MAX_CONSECUTIVE_LSP_FAILURES) {
            // One loud, actionable message, then stop the per-write noise for
            // the rest of the session. The model must not learn to ignore LSP.
            this.disabledServers.add(key);
            result.output += `\n\n[LSP disabled: ${t("lsp.unavailable")}]`;
          } else {
            result.output += `\n\n[LSP check failed]: ${msg}`;
          }
        }
      },
    };
  }

  /**
   * On-demand diagnostics tool. LSP checks only ran after write/edit (the
   * plugin above), so a read-only "check this project for errors" task got
   * ZERO compiler feedback — the model scanned files with read_file and never
   * learned whether the code compiled (observed: ses_msvuao0h — a "проверь на
   * ошибки" task ran no build, no lsp, and declared success). `lsp_check`
   * gives the model a way to ask for static diagnostics on demand.
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
        } catch {}
        if (failures >= MAX_CONSECUTIVE_LSP_FAILURES) {
          this.disabledServers.add(key);
          notes.push(`[LSP disabled: ${t("lsp.unavailable")}]`);
        } else {
          notes.push(`[LSP check failed for ${file}: ${msg}]`);
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
