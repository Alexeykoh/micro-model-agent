// src/llm/provider.ts

export interface Message {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	tool_call_id?: string;
	name?: string;
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
}

export interface LLMProvider {
	readonly model: string;
	readonly contextWindow: number;

	chat(messages: Message[], tools?: ToolDefinition[]): AsyncIterable<Chunk>;

	countTokens(text: string): number;
}
