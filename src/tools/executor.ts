import type { ToolContext, ToolCall, ToolResult, PluginManager } from "./types";
import type { ToolRegistry } from "./registry";
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

	/**
	 * Execute a tool by name with plain arguments (no call id, no timeout
	 * wiring). Used internally — e.g. bash redirects a mistaken tool-call-as-
	 * command into the real tool. Runs through the same registry and plugin
	 * hooks as a normal call.
	 */
	async executeByName(
		name: string,
		args: Record<string, unknown>,
		ctx?: ToolContext,
	): Promise<ToolResult> {
		const prevCtx = this.ctx;
		if (ctx) this.ctx = ctx;
		try {
			return await this.execute({
				id: `redirect_${Date.now()}`,
				name,
				arguments: args,
			});
		} finally {
			this.ctx = prevCtx;
		}
	}

	/** Whether a tool with this name is registered (used before redirects). */
	hasTool(name: string): boolean {
		return this.registry.has(name);
	}

	async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
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
					if (proceed === false || typeof proceed === "string") {
						const pluginName =
							(plugin as { name?: string }).name ||
							plugin.constructor?.name ||
							"unknown";
						const reason = typeof proceed === "string" ? proceed : undefined;
						return {
							success: false,
							output: reason
								? t("tool.blocked_reason", { plugin: pluginName, reason })
								: t("tool.blocked", { plugin: pluginName }),
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
				const timeoutMs = tool.timeoutMs ?? TOOL_EXECUTION_TIMEOUT_MS;
				const timeoutPromise = new Promise<ToolResult>((_, reject) => {
					setTimeout(() => {
						// Kill any long-running child process registered for this call.
						killByCallId(call.id);
						reject(
							new Error(
								t("tool.timeout", {
									name: call.name,
									seconds: Math.round(timeoutMs / 1000),
								}),
							),
						);
					}, timeoutMs);
				});
				const racePromises: Promise<ToolResult>[] = [
					tool.handler(this.ctx, call.arguments),
					timeoutPromise,
				];
				if (signal) {
					const abortPromise = new Promise<ToolResult>((_, reject) => {
						const onAbort = () => {
							killByCallId(call.id);
							reject(new Error(t("tool.aborted", { name: call.name })));
						};
						if (signal.aborted) {
							onAbort();
						} else {
							signal.addEventListener("abort", onAbort, { once: true });
						}
					});
					racePromises.push(abortPromise);
				}
				result = await Promise.race(racePromises);
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

		this.ctx.logger.logToolCall(
			call.name,
			JSON.stringify(call.arguments)?.slice(0, 200) ?? "",
			result.success ? "OK" : `FAIL: ${result.output?.slice(0, 200)}`,
		);
		this.ctx.logger.logToolOutput(
			call.name,
			result.output ?? "",
			result.success ? 0 : 1,
		);
		this.ctx.logger.debug(
			`Tool ${call.name}: ${result.success ? "OK" : "FAIL"}`,
		);
		return result;
	}

	getToolDefinitions(tags?: string[]): Array<{
		name: string;
		description: string;
		parameters: Record<string, unknown>;
		boundedOutput?: boolean;
	}> {
		return this.registry.getAllForLLM(tags);
	}

	getRegistry(): ToolRegistry {
		return this.registry;
	}

	setScope(scope: import("./types").ToolScope): void {
		this.ctx.scope = scope;
	}

	updateProvider(provider: import("../llm/provider").LLMProvider): void {
		this.ctx.llmProvider = provider;
	}
}
