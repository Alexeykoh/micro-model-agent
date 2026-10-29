// Guard (B-25): пользователь видит одну короткую ошибку LLM, а не сырой JSON
// дважды. Диагностика с полным телом уходит в verbose/файл.
import { describe, it, expect } from "vitest";
import { friendlyLlmMessage } from "../src/core/agent/loop-llm-errors";

describe("friendlyLlmMessage", () => {
  it("достаёт message из JSON ошибки провайдера", () => {
    const raw =
      'Ошибка LLM API 400 (Bad Request): {"error":{"message":"Failed to load model \\"x\\"","type":"invalid_request_error"}}';
    expect(friendlyLlmMessage(raw)).toBe(
      'Ошибка LLM API 400 (Bad Request): Failed to load model "x"',
    );
  });

  it("берёт message из плоского объекта", () => {
    expect(friendlyLlmMessage('boom: {"message":"rate limit"}')).toBe("boom: rate limit");
  });

  it("не ломается на не-JSON и многострочном тексте", () => {
    expect(friendlyLlmMessage("network down\nstack")).toBe("network down");
    expect(friendlyLlmMessage("   ")).toBe("");
  });
});
