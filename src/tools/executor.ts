import type { ToolContext, ToolCall, ToolResult, PluginManager } from "./types";
import { ToolRegistry } from "./registry";
import { killByCallId } from "../modules/processes/runner";
import { t } from "../i18n/index";

const TOOL_EXECUTION_TIMEOUT_MS = 60000;

export class ToolExecutor {
  private registry: ToolRegistry;
  private ctx: ToolContext;
  private pluginManager: PluginManager;

  constructor(
    registry: ToolRegistry,
    ctx: ToolContext,
    pluginManager: PluginManager,
  ) {
    this.registry = registry;
    this.ctx = ctx;
    this.pluginManager = pluginManager;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      return {
        success: false,
        output: t("tool.unknown", { name: call.name }),
        toolCallId: call.id,
      };
    }

    for (const plugin of this.pluginManager.getAllPlugins()) {
      if (plugin.onBeforeTool) {
        try {
          const proceed = await plugin.onBeforeTool(this.ctx, call);
          if (!proceed) {
            return {
              success: false,
              output: t("tool.blocked", {
                plugin: plugin.constructor?.name || "unknown",
              }),
              toolCallId: call.id,
            };
          }
        } catch (e: any) {
          this.ctx.logger.warn(`Plugin onBeforeTool error: ${e.message}`);
        }
      }
    }

    let result: ToolResult;
    try {
      this.ctx.activeCallId = call.id;
      if (tool.interactive) {
        // Interactive tools wait for user input — no timeout.
        result = await tool.handler(this.ctx, call.arguments);
      } else {
        const timeoutPromise = new Promise<ToolResult>((_, reject) => {
          setTimeout(
            () => {
              // Kill any long-running child process registered for this call.
              killByCallId(call.id);
              reject(
                new Error(
                  t("tool.timeout", {
                    name: call.name,
                    seconds: TOOL_EXECUTION_TIMEOUT_MS / 1000,
                  }),
                ),
              );
            },
            TOOL_EXECUTION_TIMEOUT_MS,
          );
        });
        result = await Promise.race([
          tool.handler(this.ctx, call.arguments),
          timeoutPromise,
        ]);
      }
      result.toolCallId = call.id;
    } catch (e: any) {
      result = {
        success: false,
        output: `${t("error.prefix")}${e.message}`,
        toolCallId: call.id,
      };
    }

    for (const plugin of this.pluginManager.getAllPlugins()) {
      if (plugin.onAfterTool) {
        try {
          await plugin.onAfterTool(this.ctx, call, result);
        } catch (e: any) {
          this.ctx.logger.warn(`Plugin onAfterTool error: ${e.message}`);
        }
      }
    }

    this.ctx.logger.debug(
      `Tool ${call.name}: ${result.success ? "OK" : "FAIL"}`,
    );
    return result;
  }

  getToolDefinitions(
    tags?: string[],
  ): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> {
    return this.registry.getAllForLLM(tags);
  }
}
