// src/llm/token-counter.ts
import { encodingForModel, getEncoding } from "js-tiktoken";

export class TokenCounter {
	private encoder: ReturnType<typeof getEncoding>;

	constructor(model: string = "gpt-4o") {
		try {
			this.encoder = encodingForModel(model as any);
		} catch {
			// Fallback to cl100k_base for unknown models
			this.encoder = getEncoding("cl100k_base");
		}
	}

	count(text: string): number {
		if (!text) return 0;
		return this.encoder.encode(text).length;
	}

	countMessages(messages: Array<{ role: string; content: string }>): number {
		let total = 0;
		for (const msg of messages) {
			// ~4 tokens per message overhead (role, boundaries)
			total += 4;
			total += this.count(msg.content);
			if (msg.role === "tool") total += 2; // tool_call_id
		}
		total += 2; // assistant priming
		return total;
	}

	encode(text: string): number[] {
		return this.encoder.encode(text);
	}

	decode(tokens: number[]): string {
		return this.encoder.decode(tokens);
	}
}
