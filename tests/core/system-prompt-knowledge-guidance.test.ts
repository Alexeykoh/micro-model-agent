// Гвард к `docs/specs/2026-10-23-knowledge-turn-guidance-design.md`: правило
// «знаниевый вопрос отвечается сразу, без инструментов рабочей области» обязано
// быть в СТАТИЧЕСКОМ блоке промпта. Без проверки оно исчезает при первом
// рефакторинге промпта (правило 5 AGENTS), и слабая модель снова уходит в
// glob×3/read_file×3 на вопросе про погоду (аудит 2026-10-23).
import { describe, it, expect } from "vitest";
import { buildSystemInfo } from "../../src/core/system-prompt";
import { DEFAULTS } from "../../src/config/defaults";

function prompt(): string {
  return buildSystemInfo(structuredClone(DEFAULTS), "/tmp/proj", "win32, node 20");
}

describe("system prompt: знаниевый вопрос без обхода рабочей области", () => {
  it("правило есть в статическом блоке", () => {
    const text = prompt();
    expect(text).toContain("GENERAL KNOWLEDGE");
    expect(text).toContain("answer directly");
    // Именно инструменты рабочей области, которые модель жгла вживую.
    expect(text).toMatch(/list_dir\/glob\/grep\/read_file\/bash/);
    // И условие, при котором они всё же нужны.
    expect(text).toContain("named file/path/project");
  });

  it("правило не дублируется", () => {
    const text = prompt();
    expect(text.split("GENERAL KNOWLEDGE").length - 1).toBe(1);
  });
});
