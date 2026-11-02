/**
 * A7: счётчики здоровья прогона субагента (тулы, чтения, запись, блоки) и
 * эвристика «аналитическая задача».
 */
import { describe, it, expect } from "vitest";
import {
  EMPTY_HEALTH,
  healthLine,
  isAnalyticalTask,
  recordToolOutcome,
  type RunHealth,
} from "../../src/tools/subagent-health";

function health(): RunHealth {
  return { ...EMPTY_HEALTH };
}

describe("subagent run health", () => {
  it("counts successful and failed tools, reads and writes", () => {
    const h = health();
    recordToolOutcome(h, "read_file", true, "content");
    recordToolOutcome(h, "grep", true, "match");
    recordToolOutcome(h, "write_file", true, "ok");
    recordToolOutcome(h, "read_file", false, "ENOENT");
    expect(h).toMatchObject({ toolsOk: 3, toolsFailed: 1, filesRead: 2, filesWritten: 1 });
  });

  it("counts security blocks separately", () => {
    const h = health();
    recordToolOutcome(h, "read_file", false, "[SECURITY BLOCKED] Path is not within scope");
    expect(h).toMatchObject({ toolsFailed: 1, blocked: 1, filesRead: 0 });
  });

  it("detects analytical tasks in Russian and English", () => {
    expect(isAnalyticalTask("прочитай README и перескажи")).toBe(true);
    expect(isAnalyticalTask("проанализируй структуру проекта")).toBe(true);
    expect(isAnalyticalTask("read src/app.ts and summarize")).toBe(true);
    expect(isAnalyticalTask("напиши файл с приветствием")).toBe(false);
    expect(isAnalyticalTask("create a new configuration")).toBe(false);
  });

  it("renders one health line for the parent model", () => {
    const h: RunHealth = {
      toolsOk: 2,
      toolsFailed: 1,
      filesRead: 1,
      filesWritten: 0,
      blocked: 0,
    };
    const line = healthLine(h);
    expect(line).toContain("tools 2 ok / 1 failed");
    expect(line).toContain("files read 1");
    expect(line).toContain("blocked 0");
  });
});
