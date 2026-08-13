import { describe, it, expect, vi } from "vitest";
import { Agent } from "../../src/core/agent";
import type { AppConfig } from "../../src/config/types";

function createMockDeps(overrides?: Record<string, unknown>) {
	const mockProvider = {
		model: "test-model",
		contextWindow: 4096,
		chat: vi.fn().mockReturnValue(
			(async function* () {
				yield { type: "text" as const, content: "Hello from mock LLM" };
				yield { type: "done" as const, finishReason: "stop" as const };
			})(),
		),
		countTokens: vi.fn().mockReturnValue(10),
	};

	const mockToolExecutor = {
		execute: vi.fn().mockResolvedValue({ success: true, output: "tool ok" }),
		getToolDefinitions: vi.fn().mockReturnValue([]),
	};

	const mockPluginManager = {
		getAllPlugins: vi.fn().mockReturnValue([]),
		runOnBuildPrompt: vi.fn().mockReturnValue([]),
		runOnBeforeThink: vi.fn(),
		runOnBeforeTool: vi.fn().mockResolvedValue(true),
		runOnAfterTool: vi.fn(),
		runOnAfterThink: vi.fn(),
		runOnToolCall: vi.fn(),
		runOnPhase: vi.fn(),
		runOnToolStart: vi.fn(),
		runOnToolEnd: vi.fn(),
		runOnText: vi
			.fn()
			.mockImplementation((_ctx: unknown, chunk: string) => chunk),
		runOnMeta: vi
			.fn()
			.mockImplementation((_ctx: unknown, chunk: string) => chunk),
		runOnError: vi.fn(),
		runOnSessionStart: vi.fn(),
		runOnSessionEnd: vi.fn(),
	};

	const mockContextManager = {
		addMessage: vi.fn(),
		getMessageCount: vi.fn().mockReturnValue(0),
		needsCompaction: vi.fn().mockReturnValue(false),
		compact: vi.fn(),
		getActiveHistory: vi.fn().mockReturnValue([]),
		getEstimatedTokens: vi.fn().mockReturnValue(50),
		getBudget: vi.fn().mockReturnValue({
			systemPrompt: 1024,
			responseReserve: 512,
			history: 2560,
		}),
		updateSystemPrompt: vi.fn(),
		getCompactionCount: vi.fn().mockReturnValue(0),
		getIterationsSinceCompaction: vi.fn().mockReturnValue(0),
		getQuality: vi.fn().mockReturnValue(100),
		noteIteration: vi.fn(),
		setToolTokens: vi.fn(),
	};

	const mockHallucinationDetector = {
		validate: vi.fn().mockReturnValue({ status: "pass" as const }),
		getConfidenceCheck: vi.fn().mockReturnValue({
			setPreviousResponse: vi.fn(),
		}),
		getConsistencyCheck: vi.fn().mockReturnValue({
			trackDecision: vi.fn(),
			trackCreatedFile: vi.fn(),
			trackDeletedFile: vi.fn(),
		}),
	};

	const mockLogger = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		logLLMRequest: vi.fn(),
		logLLMResponse: vi.fn(),
		logToolCall: vi.fn(),
		logToolOutput: vi.fn(),
		initSessionLog: vi.fn(),
		closeSessionLog: vi.fn(),
	};

	const config: AppConfig = {
		version: "2.0.0",
		model: "test-model",
		provider: { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
		orchestrator: {},
		moe: { enabled: false },
		experts: {},
		contextWindow: 4096,
		contextBudget: {
			systemPrompt: 0.25,
			responseReserve: 0.12,
			compactionThreshold: 0.75,
		},
		modelLoad: { autoLoad: false },
		retry: { maxRetries: 3, baseDelay: 1000, maxDelay: 30000 },
		maxToolIterations: 5,
		stuckThreshold: 8,
		autoPlan: true,
		showReasoning: true,
		logLevel: "info",
		locale: "en",
		session: { autoSave: true, maxSessions: 50, isolateMemory: false },
		browser: {
			enabled: true,
			headless: true,
			maxElements: 30,
			maxContentChars: 2500,
			maxConsoleEntries: 20,
			viewportWidth: 1280,
			viewportHeight: 720,
			navigationTimeout: 15000,
		},
		mcpServers: {},
		ui: {
			spinner: true,
			toolStyle: "inline",
			toolComments: true,
			showContextStats: false,
			showCompaction: false,
		},
		skills: { budget: 8000 },
	};

	return {
		config,
		llmProvider: mockProvider,
		toolExecutor: mockToolExecutor,
		pluginManager: mockPluginManager,
		contextManager: mockContextManager,
		hallucinationDetector: mockHallucinationDetector,
		logger: mockLogger,
		baseDir: "/tmp",
		promptBlocks: [],
		...overrides,
	};
}

describe("Agent", () => {
	it("returns text response for simple text LLM output", async () => {
		const deps = createMockDeps();
		const agent = new Agent(deps as any);
		const result = await agent.run("hello");
		expect(result.text).toBe("Hello from mock LLM");
		expect(result.success).toBe(true);
	});

	it("estimates token metrics locally when the backend omits usage", async () => {
		const mockProvider = {
			model: "test-model",
			contextWindow: 4096,
			// No `done` chunk with usage → api tokens stay 0 → local fallback
			chat: vi.fn().mockReturnValue(
				(async function* () {
					yield { type: "text" as const, content: "An answer of some length" };
					yield { type: "done" as const, finishReason: "stop" as const };
				})(),
			),
			countTokens: vi.fn().mockReturnValue(10),
		};
		const deps = createMockDeps({ llmProvider: mockProvider });
		const agent = new Agent(deps as any);
		const result = await agent.run("task");
		expect(result.success).toBe(true);
		// prompt falls back to the estimated context size (mock returns 50)
		expect(result.promptTokens).toBeGreaterThan(0);
		// completion falls back to chars/4 of the generated text
		expect(result.completionTokens).toBeGreaterThan(0);
		expect(result.totalTokens).toBe(
			result.promptTokens! + result.completionTokens!,
		);
	});

	it("keeps the final text when exitOnComplete breaks on a retry-flagged response", async () => {
		const mockProvider = {
			model: "test-model",
			contextWindow: 4096,
			chat: vi
				.fn()
				.mockReturnValueOnce(
					(async function* () {
						yield {
							type: "tool_call" as const,
							toolCall: {
								id: "t1",
								name: "bash",
								arguments: "{}",
							},
						};
						yield {
							type: "done" as const,
							finishReason: "tool_calls" as const,
						};
					})(),
				)
				.mockReturnValueOnce(
					(async function* () {
						yield { type: "text" as const, content: "Done! check-env works" };
						yield { type: "done" as const, finishReason: "stop" as const };
					})(),
				),
			countTokens: vi.fn().mockReturnValue(10),
		};
		const deps = createMockDeps({
			llmProvider: mockProvider,
			exitOnComplete: true,
			hallucinationDetector: {
				validate: vi
					.fn()
					.mockReturnValueOnce({ status: "pass" as const })
					.mockReturnValueOnce({ status: "retry" as const, reason: "short" }),
				getConfidenceCheck: vi.fn().mockReturnValue({
					setPreviousResponse: vi.fn(),
				}),
				getConsistencyCheck: vi.fn().mockReturnValue({
					trackDecision: vi.fn(),
					trackCreatedFile: vi.fn(),
					trackDeletedFile: vi.fn(),
				}),
			},
		});
		const agent = new Agent(deps as any);
		const result = await agent.run("run the check");
		// The retry-flagged final response must still be surfaced as the result
		expect(result.success).toBe(true);
		expect(result.text).toBe("Done! check-env works");
	});

	it("gives the model a second chance after a repeated tool call under exitOnComplete", async () => {
		const bashCall = {
			type: "tool_call" as const,
			toolCall: { id: "t1", name: "bash", arguments: "{}" },
		};
		const mockProvider = {
			model: "test-model",
			contextWindow: 4096,
			chat: vi
				.fn()
				.mockReturnValueOnce(
					(async function* () {
						yield bashCall;
						yield {
							type: "done" as const,
							finishReason: "tool_calls" as const,
						};
					})(),
				)
				.mockReturnValueOnce(
					(async function* () {
						// identical tool call again
						yield bashCall;
						yield {
							type: "done" as const,
							finishReason: "tool_calls" as const,
						};
					})(),
				)
				.mockReturnValueOnce(
					(async function* () {
						yield { type: "text" as const, content: "All done now" };
						yield { type: "done" as const, finishReason: "stop" as const };
					})(),
				),
			countTokens: vi.fn().mockReturnValue(10),
		};
		const addMessage = vi.fn();
		const deps = createMockDeps({
			llmProvider: mockProvider,
			exitOnComplete: true,
			contextManager: {
				addMessage,
				getMessageCount: vi.fn().mockReturnValue(0),
				needsCompaction: vi.fn().mockReturnValue(false),
				compact: vi.fn(),
				getActiveHistory: vi.fn().mockReturnValue([]),
				getEstimatedTokens: vi.fn().mockReturnValue(50),
				getBudget: vi.fn().mockReturnValue({
					systemPrompt: 1024,
					responseReserve: 512,
					history: 2560,
				}),
				updateSystemPrompt: vi.fn(),
				getCompactionCount: vi.fn().mockReturnValue(0),
				getIterationsSinceCompaction: vi.fn().mockReturnValue(0),
				getQuality: vi.fn().mockReturnValue(100),
				noteIteration: vi.fn(),
				setToolTokens: vi.fn(),
			},
		});
		const agent = new Agent(deps as any);
		const result = await agent.run("run twice");
		// The repeated call must NOT have stopped the run — the model got a
		// chance to answer and its final text is preserved.
		expect(mockProvider.chat).toHaveBeenCalledTimes(3);
		expect(
			addMessage.mock.calls.some(
				(c: any) =>
					typeof c[0]?.content === "string" &&
					c[0].content.includes("same tool with identical arguments"),
			),
		).toBe(true);
		expect(result.text).toBe("All done now");
	});

	it("retries empty (reasoning-only) responses and returns the final text", async () => {
		const mockProvider = {
			model: "test-model",
			contextWindow: 4096,
			chat: vi
				.fn()
				.mockReturnValueOnce(
					(async function* () {
						yield { type: "reasoning" as const, content: "thinking..." };
						yield { type: "done" as const, finishReason: "stop" as const };
					})(),
				)
				.mockReturnValueOnce(
					(async function* () {
						yield { type: "reasoning" as const, content: "still thinking..." };
						yield { type: "done" as const, finishReason: "stop" as const };
					})(),
				)
				.mockReturnValueOnce(
					(async function* () {
						yield { type: "text" as const, content: "Final answer" };
						yield { type: "done" as const, finishReason: "stop" as const };
					})(),
				),
			countTokens: vi.fn().mockReturnValue(10),
		};
		const deps = createMockDeps({ llmProvider: mockProvider });
		const agent = new Agent(deps as any);
		const result = await agent.run("task");
		expect(mockProvider.chat).toHaveBeenCalledTimes(3);
		expect(result.text).toBe("Final answer");
		expect(result.success).toBe(true);
	});

	it("returns success:false when empty responses exhaust retries", async () => {
		const mockProvider = {
			model: "test-model",
			contextWindow: 4096,
			chat: vi.fn().mockReturnValue(
				(async function* () {
					yield { type: "reasoning" as const, content: "thinking..." };
					yield { type: "done" as const, finishReason: "stop" as const };
				})(),
			),
			countTokens: vi.fn().mockReturnValue(10),
		};
		const deps = createMockDeps({ llmProvider: mockProvider });
		const agent = new Agent(deps as any);
		const result = await agent.run("task");
		// 1 initial + 2 retries, then exhausted
		expect(mockProvider.chat).toHaveBeenCalledTimes(3);
		expect(result.success).toBe(false);
		expect(result.error).toContain("empty");
	});

	it("executes tool calls and continues loop", async () => {
		const mockProvider = {
			model: "test-model",
			contextWindow: 4096,
			chat: vi
				.fn()
				.mockReturnValueOnce(
					(async function* () {
						yield {
							type: "tool_call" as const,
							toolCall: { id: "call-1", name: "test_tool", arguments: "{}" },
						};
						yield {
							type: "done" as const,
							finishReason: "tool_calls" as const,
						};
					})(),
				)
				.mockReturnValueOnce(
					(async function* () {
						yield { type: "text" as const, content: "Done after tool" };
						yield { type: "done" as const, finishReason: "stop" as const };
					})(),
				),
			countTokens: vi.fn().mockReturnValue(10),
		};

		const mockExecutor = {
			execute: vi.fn().mockResolvedValue({
				success: true,
				output: "tool executed",
				toolCallId: "call-1",
			}),
			getToolDefinitions: vi.fn().mockReturnValue([]),
		};

		const deps = createMockDeps({
			llmProvider: mockProvider as any,
			toolExecutor: mockExecutor as any,
		});
		const agent = new Agent(deps as any);
		const result = await agent.run("do something");
		expect(result.text).toBe("Done after tool");
		expect(mockExecutor.execute).toHaveBeenCalledTimes(1);

		const assistantMsg = deps.contextManager.addMessage.mock.calls.find(
			(call: any) => call[0].role === "assistant" && call[0].tool_calls,
		);
		expect(assistantMsg).toBeDefined();
		expect(assistantMsg![0].tool_calls[0].id).toBe("call-1");

		const toolMsg = deps.contextManager.addMessage.mock.calls.find(
			(call: any) =>
				call[0].role === "tool" && call[0].tool_call_id === "call-1",
		);
		expect(toolMsg).toBeDefined();
		expect(toolMsg![0].name).toBe("test_tool");
	});

	it("limits max iterations and returns partial result", async () => {
		const mockProvider = {
			model: "test-model",
			contextWindow: 4096,
			chat: vi.fn().mockReturnValue(
				(async function* () {
					yield {
						type: "tool_call" as const,
						toolCall: { id: "call-x", name: "test_tool", arguments: "{}" },
					};
					yield { type: "done" as const, finishReason: "tool_calls" as const };
				})(),
			),
			countTokens: vi.fn().mockReturnValue(10),
		};

		const mockExecutor = {
			execute: vi.fn().mockResolvedValue({
				success: true,
				output: "tool ok",
				toolCallId: "call-x",
			}),
			getToolDefinitions: vi.fn().mockReturnValue([]),
		};

		const deps = createMockDeps({
			llmProvider: mockProvider as any,
			toolExecutor: mockExecutor as any,
			config: { ...createMockDeps().config, maxToolIterations: 2 },
		});
		const agent = new Agent(deps as any);
		const result = await agent.run("loop forever");
		expect(result.success).toBe(false);
		expect(result.error).toContain("iteration");
	});

	it("hallucination block prevents tool execution", async () => {
		const mockProvider = {
			model: "test-model",
			contextWindow: 4096,
			chat: vi.fn().mockReturnValue(
				(async function* () {
					yield { type: "text" as const, content: "I will delete everything" };
					yield { type: "done" as const, finishReason: "stop" as const };
				})(),
			),
			countTokens: vi.fn().mockReturnValue(10),
		};

		const detector = {
			validate: vi.fn().mockReturnValue({
				status: "block" as const,
				reason: "Dangerous action detected",
			}),
			getConfidenceCheck: vi.fn().mockReturnValue({
				setPreviousResponse: vi.fn(),
			}),
			getConsistencyCheck: vi.fn().mockReturnValue({
				trackDecision: vi.fn(),
				trackCreatedFile: vi.fn(),
				trackDeletedFile: vi.fn(),
			}),
		};

		const deps = createMockDeps({
			llmProvider: mockProvider as any,
			hallucinationDetector: detector as any,
		});
		const agent = new Agent(deps as any);
		const result = await agent.run("delete everything");
		expect(result.success).toBe(false);
		expect(result.error).toContain("blocked");
	});

	it("exitOnComplete does not break on empty text flagged as retry", async () => {
		const mockProvider = {
			model: "test-model",
			contextWindow: 4096,
			chat: vi
				.fn()
				.mockReturnValueOnce(
					(async function* () {
						yield { type: "reasoning" as const, content: "thinking..." };
						yield { type: "done" as const, finishReason: "stop" as const };
					})(),
				)
				.mockReturnValueOnce(
					(async function* () {
						yield { type: "text" as const, content: "Final answer" };
						yield { type: "done" as const, finishReason: "stop" as const };
					})(),
				),
			countTokens: vi.fn().mockReturnValue(10),
		};

		const detector = {
			validate: vi.fn().mockImplementation((text: string) => ({
				status: text?.trim() ? ("pass" as const) : ("retry" as const),
				reason: text?.trim() ? undefined : "empty response",
			})),
			getConfidenceCheck: vi.fn().mockReturnValue({
				setPreviousResponse: vi.fn(),
			}),
			getConsistencyCheck: vi.fn().mockReturnValue({
				trackDecision: vi.fn(),
				trackCreatedFile: vi.fn(),
				trackDeletedFile: vi.fn(),
			}),
		};

		const deps = createMockDeps({
			llmProvider: mockProvider as any,
			hallucinationDetector: detector as any,
			config: { ...createMockDeps().config, exitOnComplete: true },
		});
		const agent = new Agent(deps as any);
		const result = await agent.run("task");
		expect(mockProvider.chat).toHaveBeenCalledTimes(2);
		expect(result.success).toBe(true);
		expect(result.text).toBe("Final answer");
	});

	it("streams reasoning via onMeta when showReasoning is true", async () => {
		const mockProvider = {
			model: "test-model",
			contextWindow: 4096,
			chat: vi.fn().mockReturnValue(
				(async function* () {
					yield { type: "reasoning" as const, content: "Let me think..." };
					yield { type: "text" as const, content: "Answer" };
					yield { type: "done" as const, finishReason: "stop" as const };
				})(),
			),
			countTokens: vi.fn().mockReturnValue(10),
		};

		const deps = createMockDeps({ llmProvider: mockProvider as any });
		const agent = new Agent(deps as any);
		const meta: string[] = [];
		const text: string[] = [];
		await agent.run(
			"test",
			(c) => text.push(c),
			(m) => meta.push(m),
		);

		expect(meta.some((c) => c.includes("Let me think"))).toBe(true);
		expect(text.some((c) => c.includes("Answer"))).toBe(true);
		expect(text.some((c) => c.includes("Let me think"))).toBe(false);
	});

	it("hides reasoning when showReasoning is false", async () => {
		const mockProvider = {
			model: "test-model",
			contextWindow: 4096,
			chat: vi.fn().mockReturnValue(
				(async function* () {
					yield { type: "reasoning" as const, content: "Hidden thought" };
					yield { type: "text" as const, content: "Visible" };
					yield { type: "done" as const, finishReason: "stop" as const };
				})(),
			),
			countTokens: vi.fn().mockReturnValue(10),
		};

		const config = createMockDeps().config;
		config.showReasoning = false;
		const deps = createMockDeps({ llmProvider: mockProvider as any, config });
		const agent = new Agent(deps as any);
		const meta: string[] = [];
		await agent.run("test", undefined, (m) => meta.push(m));

		expect(meta.some((c) => c.includes("Hidden thought"))).toBe(false);
	});

	it("emits thinking/done phases around each LLM call", async () => {
		const mockProvider = {
			model: "test-model",
			contextWindow: 4096,
			chat: vi.fn().mockReturnValue(
				(async function* () {
					yield { type: "text" as const, content: "Answer" };
					yield { type: "done" as const, finishReason: "stop" as const };
				})(),
			),
			countTokens: vi.fn().mockReturnValue(10),
		};

		const deps = createMockDeps({ llmProvider: mockProvider as any });
		const agent = new Agent(deps as any);
		const phases: string[] = [];
		await agent.run("test", undefined, undefined, undefined, (p) =>
			phases.push(p),
		);

		expect(phases).toEqual(["thinking", "done"]);
	});

	it("emits done phase even when the LLM call throws", async () => {
		const mockProvider = {
			model: "test-model",
			contextWindow: 4096,
			chat: vi.fn().mockReturnValue(
				(async function* () {
					throw new Error("boom");
				})(),
			),
			countTokens: vi.fn().mockReturnValue(10),
		};

		const deps = createMockDeps({ llmProvider: mockProvider as any });
		const agent = new Agent(deps as any);
		const phases: string[] = [];
		const result = await agent.run(
			"test",
			undefined,
			undefined,
			undefined,
			(p) => phases.push(p),
		);

		expect(phases).toEqual(["thinking", "done"]);
		expect(result.success).toBe(false);
	});

	it("dispatches onPhase to plugins", async () => {
		const deps = createMockDeps();
		const agent = new Agent(deps as any);
		await agent.run("test");

		const calls = (deps.pluginManager.runOnPhase as any).mock.calls;
		const phases = calls.map((c: any[]) => c[1]);
		expect(phases).toEqual(["thinking", "done"]);
	});

	it("dispatches onAfterThink with the parsed response", async () => {
		const deps = createMockDeps();
		const agent = new Agent(deps as any);
		await agent.run("test");

		const calls = (deps.pluginManager.runOnAfterThink as any).mock.calls;
		expect(calls.length).toBe(1);
		expect(calls[0][1]).toMatchObject({
			type: "text",
			content: "Hello from mock LLM",
		});
	});

	it("includes plugin prompt blocks from onBuildPrompt", async () => {
		const deps = createMockDeps({
			pluginManager: {
				...createMockDeps().pluginManager,
				runOnBuildPrompt: vi
					.fn()
					.mockReturnValue(["### Plugin rule: be brief"]),
			},
		});
		const agent = new Agent(deps as any);
		await agent.run("test");

		const added = deps.contextManager.addMessage as any;
		const systemMessage = added.mock.calls.find(
			(c: any[]) => c[0]?.role === "system",
		);
		expect(systemMessage).toBeDefined();
		expect(systemMessage[0].content).toContain("Plugin rule: be brief");
	});

	it("dispatches onToolStart and onToolEnd around tool execution", async () => {
		const deps = createMockDeps({
			llmProvider: {
				model: "test-model",
				contextWindow: 4096,
				chat: vi
					.fn()
					.mockReturnValueOnce(
						(async function* () {
							yield {
								type: "tool_call" as const,
								toolCall: {
									id: "call_1",
									name: "write_file",
									arguments: "{}",
								},
							};
							yield {
								type: "done" as const,
								finishReason: "tool_calls" as const,
							};
						})(),
					)
					.mockReturnValueOnce(
						(async function* () {
							yield { type: "text" as const, content: "Done" };
							yield { type: "done" as const, finishReason: "stop" as const };
						})(),
					),
				countTokens: vi.fn().mockReturnValue(10),
			},
		});
		const agent = new Agent(deps as any);
		const result = await agent.run("write a file");

		expect(result.success).toBe(true);
		expect((deps.pluginManager.runOnToolStart as any).mock.calls.length).toBe(
			1,
		);
		expect((deps.pluginManager.runOnToolEnd as any).mock.calls.length).toBe(1);
		const endCall = (deps.pluginManager.runOnToolEnd as any).mock.calls[0];
		expect(endCall[1]).toMatchObject({ name: "write_file", id: "call_1" });
		expect(endCall[2]).toMatchObject({ success: true, output: "tool ok" });
		expect(typeof endCall[3]).toBe("number");
	});

	it("applies onText and onMeta transforms to streamed output", async () => {
		const deps = createMockDeps({
			pluginManager: {
				...createMockDeps().pluginManager,
				runOnText: vi
					.fn()
					.mockImplementation((_ctx: unknown, chunk: string) =>
						chunk.replace(/secret/g, "[redacted]"),
					),
				runOnMeta: vi
					.fn()
					.mockImplementation((_ctx: unknown, chunk: string) =>
						chunk.replace(/secret/g, "[redacted]"),
					),
			},
			llmProvider: {
				model: "test-model",
				contextWindow: 4096,
				chat: vi.fn().mockReturnValue(
					(async function* () {
						yield { type: "reasoning" as const, content: "secret plan" };
						yield { type: "text" as const, content: "the secret is out" };
						yield { type: "done" as const, finishReason: "stop" as const };
					})(),
				),
				countTokens: vi.fn().mockReturnValue(10),
			},
		});
		const agent = new Agent(deps as any);
		const chunks: string[] = [];
		const meta: string[] = [];
		await agent.run(
			"test",
			(c) => chunks.push(c),
			(m) => meta.push(m),
		);

		expect(chunks.join("")).toContain("[redacted]");
		expect(chunks.join("")).not.toContain("secret");
		expect(meta.join("")).not.toContain("secret");
	});

	it("truncateToolOutput respects absolute max chars limit", () => {
		const deps = createMockDeps();
		const agent = new Agent(deps as any);
		const longOutput = "x".repeat(20000);
		const budget = { history: 20480 };
		const currentTokens = 5000;

		const result = (agent as any).truncateToolOutput(
			longOutput,
			budget,
			currentTokens,
		);
		expect(result.length).toBeLessThanOrEqual(15100);
		expect(result).toContain("Truncated");
	});

	it("truncateToolOutput does not truncate short output", () => {
		const deps = createMockDeps();
		const agent = new Agent(deps as any);
		const shortOutput = "Hello world";
		const budget = { history: 20480 };
		const currentTokens = 5000;

		const result = (agent as any).truncateToolOutput(
			shortOutput,
			budget,
			currentTokens,
		);
		expect(result).toBe(shortOutput);
	});

	it("truncateToolOutput respects remaining budget", () => {
		const deps = createMockDeps();
		const agent = new Agent(deps as any);
		const longOutput = "x".repeat(10000);
		const budget = { history: 20480 };
		const currentTokens = 19000;

		const result = (agent as any).truncateToolOutput(
			longOutput,
			budget,
			currentTokens,
		);
		expect(result.length).toBeLessThan(longOutput.length);
		expect(result).toContain("Truncated");
	});

	it("filters tool definitions by toolTags when set", async () => {
		const mockExecutor = {
			execute: vi.fn().mockResolvedValue({ success: true, output: "tool ok" }),
			getToolDefinitions: vi.fn().mockReturnValue([]),
		};

		const deps = createMockDeps({
			toolExecutor: mockExecutor as any,
			toolTags: ["file", "code"],
		});
		const agent = new Agent(deps as any);
		await agent.run("hello");

		expect(mockExecutor.getToolDefinitions).toHaveBeenCalledWith([
			"file",
			"code",
		]);
	});

	it("does not filter tools when toolTags is not set", async () => {
		const mockExecutor = {
			execute: vi.fn().mockResolvedValue({ success: true, output: "tool ok" }),
			getToolDefinitions: vi.fn().mockReturnValue([]),
		};

		const deps = createMockDeps({ toolExecutor: mockExecutor as any });
		const agent = new Agent(deps as any);
		await agent.run("hello");

		expect(mockExecutor.getToolDefinitions).toHaveBeenCalledWith(undefined);
	});

	it("delegates to single-agent loop when moe is disabled", async () => {
		const deps = createMockDeps({
			config: { ...createMockDeps().config, moe: { enabled: false } },
		});
		const agent = new Agent(deps as any);
		const result = await agent.run("hello");
		expect(result.text).toBe("Hello from mock LLM");
		expect(result.success).toBe(true);
	});

	it("does not force a compaction on every single iteration when quality is low", async () => {
		let compactCalls = 0;
		const deps = createMockDeps({
			config: { ...createMockDeps().config, maxToolIterations: 20 },
			llmProvider: {
				model: "test-model",
				contextWindow: 4096,
				chat: vi.fn().mockImplementation(() =>
					(async function* () {
						yield {
							type: "tool_call" as const,
							toolCall: { id: "call_1", name: "read_file", arguments: "{}" },
						};
						yield { type: "done" as const, finishReason: "tool_calls" as const };
					})(),
				),
				countTokens: vi.fn().mockReturnValue(10),
			},
			contextManager: {
				addMessage: vi.fn(),
				getMessageCount: vi.fn().mockReturnValue(10),
				needsCompaction: vi.fn().mockReturnValue(false),
				compact: vi.fn(() => { compactCalls++; }),
				getActiveHistory: vi.fn().mockReturnValue([{ role: "user", content: "hello" }]),
				getEstimatedTokens: vi.fn().mockReturnValue(100),
				getBudget: vi.fn().mockReturnValue({
					systemPrompt: 1024,
					responseReserve: 512,
					history: 2560,
				}),
				updateSystemPrompt: vi.fn(),
				getCompactionCount: vi.fn().mockReturnValue(5),
				getIterationsSinceCompaction: vi.fn().mockReturnValue(0),
				getQuality: vi.fn().mockReturnValue(30),
				noteIteration: vi.fn(),
				setToolTokens: vi.fn(),
			} as any,
		});
		const agent = new Agent(deps as any);
		const result = await agent.run("hello");
		// A cooldown of >= 3 iterations means at most ~7 forced compactions in
		// 20 iterations, NOT one per iteration (which was the death spiral).
		expect(compactCalls).toBeLessThanOrEqual(7);
		expect(result.iterationCount).toBe(20);
	});

	it("returns success:false when the final audit is still failing after retries", async () => {
		const failingAudit = async () => ({
			passed: false,
			missingFiles: ["src/missing.ts"],
			createdFiles: [],
			modifiedFiles: [],
			summary: "Task incomplete: 0/1 steps done, 1 files missing",
			typeCheckError: null,
			massEditWarning: null,
			pendingSteps: ["Create src/missing.ts"],
		});
		const deps = createMockDeps({
			finalAudit: failingAudit,
			llmProvider: {
				model: "test-model",
				contextWindow: 4096,
				chat: vi.fn().mockImplementation(() =>
					(async function* () {
						yield { type: "text" as const, content: "Hello from mock LLM" };
						yield { type: "done" as const, finishReason: "stop" as const };
					})(),
				),
				countTokens: vi.fn().mockReturnValue(10),
			},
		});
		const agent = new Agent(deps as any);
		const result = await agent.run("hello");
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	it("finishes after audit retry limit instead of looping forever", async () => {
		let auditCalls = 0;
		const failingAudit = async () => {
			auditCalls++;
			return {
				passed: false,
				missingFiles: ["src/missing.ts"],
				createdFiles: [],
				modifiedFiles: [],
				summary: "Task incomplete: 0/1 steps done, 1 files missing",
				typeCheckError: null,
				massEditWarning: null,
				pendingSteps: ["Create src/missing.ts"],
			};
		};

		const deps = createMockDeps({
			finalAudit: failingAudit,
			llmProvider: {
				model: "test-model",
				contextWindow: 4096,
				chat: vi.fn().mockImplementation(() =>
					(async function* () {
						yield { type: "text" as const, content: "Hello from mock LLM" };
						yield { type: "done" as const, finishReason: "stop" as const };
					})(),
				),
				countTokens: vi.fn().mockReturnValue(10),
			},
		});
		const agent = new Agent(deps as any);
		const result = await agent.run("hello");

		expect(auditCalls).toBe(3);
		expect(result.success).toBe(false);
		expect(deps.llmProvider.chat).toHaveBeenCalledTimes(3);
	});
});
