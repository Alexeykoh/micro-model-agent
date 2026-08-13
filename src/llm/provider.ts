// src/llm/provider.ts

export interface TextPart {
	type: "text";
	text: string;
}

export interface ImageUrlPart {
	type: "image_url";
	image_url: { url: string };
}

export type ContentPart = TextPart | ImageUrlPart;

export interface Message {
	role: "system" | "user" | "assistant" | "tool";
	content: string | ContentPart[];
	tool_call_id?: string;
	name?: string;
}

/** Helper: extract plain text from message content (for token counting, logging, etc.) */
export function getMessageText(content: string | ContentPart[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((p): p is TextPart => p.type === "text")
		.map((p) => p.text)
		.join("");
}

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface Chunk {
	type: "text" | "reasoning" | "tool_call" | "done";
	content?: string;
	toolCall?: {
		id: string;
		name: string;
		arguments: string;
	};
	finishReason?: "stop" | "length" | "tool_calls";
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
}

export interface ChatOptions {
	/** Cap on generated tokens for this call (overrides provider default). */
	maxTokens?: number;
	/**
	 * Reasoning effort for models that support it (OpenAI-compat `reasoning_effort`).
	 * "none" disables long "thinking" chains so the budget goes to the answer —
	 * essential for chunk queries on reasoning models (qwen3.5), where thinking
	 * alone can consume all of maxTokens and leave an empty text answer.
	 */
	reasoningEffort?: "none" | "low" | "medium" | "high";
}

export interface LLMProvider {
	readonly model: string;
	readonly contextWindow: number;

	chat(
		messages: Message[],
		tools?: ToolDefinition[],
		signal?: AbortSignal,
		options?: ChatOptions,
	): AsyncIterable<Chunk>;

	countTokens(text: string): number;

	listModels(): Promise<string[]>;
}
