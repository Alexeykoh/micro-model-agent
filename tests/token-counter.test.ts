// tests/token-counter.test.ts
import { describe, it, expect } from "vitest";
import { TokenCounter } from "../src/llm/token-counter";

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
