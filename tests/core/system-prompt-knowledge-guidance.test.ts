// Гвард к `docs/specs/2026-10-23-knowledge-turn-guidance-design.md` и его
// уточнению `docs/specs/2026-10-31-live-data-grounding-guidance-design.md`:
// правило «знаниевый вопрос отвечается сразу, без инструментов рабочей области»
// обязано быть в СТАТИЧЕСКОМ блоке промпта, но погода/цены/новости — это не
// «общие знания», а живые данные: их получают веб-инструментами.
//
// Без проверки правило исчезает при первом рефакторинге промпта (правило 5
// AGENTS). Живой дефект 2026-10-31 (сессия ses_mvw29n78_mwbgalvahutvwfbj):
// промпт отнёс погоду к GENERAL KNOWLEDGE, модель не вызвала web_search и
// выдала «ищу погоду…» за ответ — два критичных вердикта критика подряд.
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
    expect(text.split("LIVE DATA").length - 1).toBe(1);
  });
});

describe("system prompt: живые данные требуют веб-обоснования", () => {
  it("погода/цены не выдаются за общие знания", () => {
    const text = prompt();
    const general = text.match(/GENERAL KNOWLEDGE \(([^)]*)\)/);
    expect(general).not.toBeNull();
    expect(general![1]).not.toMatch(/weather|prices/i);
  });

  it("есть отдельное правило про живые данные и веб-инструменты", () => {
    const text = prompt();
    expect(text).toMatch(/LIVE DATA[^\n]*weather[^\n]*prices/);
    expect(text).toContain("call web_search/web_fetch first");
    // Не смог получить — скажи прямо, а не выдумывай и не отдавай план поиска.
    expect(text).toContain("could not get the data");
  });

  it("строка «ищу…» — превью, а не ответ", () => {
    // v3 сжал блок NARRATION; запрет «план поиска вместо ответа» остался в
    // правиле про живые данные.
    expect(prompt()).toContain("never present a search plan as the answer");
  });
});
