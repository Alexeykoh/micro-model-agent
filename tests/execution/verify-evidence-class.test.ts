// Guard: verify отличает статическое доказательство от поведенческого.
//
// Регресс из стресс-теста (волна 21): шаг «добавь поиск в каталог» с проверкой
// `command: bun run build` принимался как выполненный, хотя страница падала в
// рантайме (`has is not a function`). Спека:
// docs/specs/2026-10-28-turn-runtime-gate-design.md (W1).
import { describe, it, expect } from "vitest";
import {
  classifyCheck,
  isBehaviorStep,
  parseCheck,
} from "../../src/modules/execution/plan-checks";

function kindOf(check: string) {
  const parsed = parseCheck(check);
  expect(parsed, `check не разобран: ${check}`).toBeTruthy();
  return parsed!;
}

describe("классификация доказательств", () => {
  it("build/typecheck/lint — статика", () => {
    for (const check of [
      "command: bun run build",
      "command: npm run typecheck",
      "command: npx tsc --noEmit",
      "command: bunx biome check .",
      "command: eslint src",
    ]) {
      expect(classifyCheck(kindOf(check)), check).toBe("static");
    }
  });

  it("тесты и запуск — поведение", () => {
    for (const check of [
      "command: bun test",
      "command: npm test",
      "command: curl -s http://127.0.0.1:5173/",
      "command: python -m pytest",
    ]) {
      expect(classifyCheck(kindOf(check)), check).toBe("behavioral");
    }
  });

  it("file-exists — статика, manual и http — поведение", () => {
    expect(classifyCheck(kindOf("file-exists:src/a.ts"))).toBe("static");
    expect(classifyCheck(kindOf("manual:открыл страницу, видны 6 карточек"))).toBe("behavioral");
    expect(classifyCheck(kindOf("http:http://127.0.0.1:5173/"))).toBe("behavioral");
    expect(classifyCheck(kindOf("http:http://127.0.0.1:5173/~Карточки"))).toBe("behavioral");
  });

  it("http: без url не парсится", () => {
    expect(parseCheck("http:")).toBeNull();
  });
});

describe("признаки шага, меняющего поведение", () => {
  it("UI-шаги распознаются по словам (ru/en)", () => {
    for (const d of [
      "Добавь поиск в компонент каталога",
      "Сделать страницу настроек",
      "fix the layout of the header",
      "новый экран выбора",
      "поправь стили карточки",
    ]) {
      expect(isBehaviorStep(d), d).toBe(true);
    }
  });

  it("не-UI шаги не считаются поведенческими", () => {
    for (const d of [
      "Обнови CHANGELOG",
      "Добавь метод в src/utils/math.ts",
      "Переименуй переменную в парсере конфига",
    ]) {
      expect(isBehaviorStep(d), d).toBe(false);
    }
  });
});
