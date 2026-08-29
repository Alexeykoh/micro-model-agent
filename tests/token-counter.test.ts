// tests/token-counter.test.ts
import { describe, it, expect } from "vitest";
import { TokenCounter, estimateTokens } from "../src/llm/token-counter";

describe("estimateTokens", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("approximates Latin text at ~4 chars/token", () => {
    const latin = "Implement a deep merge for the config objects and verify it";
    const estimate = estimateTokens(latin);
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(latin.length);
  });

  it("is within ±30% of tiktoken for Russian text", () => {
    const counter = new TokenCounter();
    const ru =
      "Исправьте логику обработки ошибок в модуле конфигурации, добавьте предупреждения и сохраните пользовательские настройки при повреждённом файле. Проверьте, что все тесты проходят.";
    const exact = counter.count(ru);
    const estimate = estimateTokens(ru);
    expect(estimate).toBeGreaterThanOrEqual(Math.round(exact * 0.7));
    expect(estimate).toBeLessThanOrEqual(Math.round(exact * 1.3));
  });

  it("handles CJK without crashing and estimates higher density than Latin", () => {
    const cjk = "中文测试文本需要更多令牌每个字符大约一个令牌";
    const estimate = estimateTokens(cjk);
    expect(estimate).toBeGreaterThan(0);
    // CJK is much denser than Latin: per-char ratio should exceed /4.
    expect(estimate).toBeGreaterThan(cjk.length / 3);
  });
});

describe("TokenCounter", () => {
  it("should count tokens in a string", () => {
    const counter = new TokenCounter();
    const count = counter.count("Hello, world!");
    expect(count).toBeGreaterThan(0);
  });

  it("should return roughly 1 token per word for short text", () => {
    const counter = new TokenCounter();
    const count = counter.count("one two three four five");
    // cl100k_base: ~0.75 tokens/word for simple English
    expect(count).toBeGreaterThanOrEqual(3);
    expect(count).toBeLessThanOrEqual(10);
  });

  it("should count tokens increasing with text length", () => {
    const counter = new TokenCounter();
    const short = counter.count("short text");
    const long = counter.count("a much longer text with many more words in it");
    expect(long).toBeGreaterThan(short);
  });

  it("should handle empty string", () => {
    const counter = new TokenCounter();
    expect(counter.count("")).toBe(0);
  });

  it("should count messages with overhead", () => {
    const counter = new TokenCounter();
    const messages = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    const count = counter.countMessages(messages);
    expect(count).toBeGreaterThan(0);
  });

  it("should encode and decode", () => {
    const counter = new TokenCounter();
    const text = "Hello, world!";
    const tokens = counter.encode(text);
    const decoded = counter.decode(tokens);
    expect(decoded).toBe(text);
  });
});
