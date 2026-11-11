// Guard: verify отличает статическое доказательство от поведенческого.
//
// Регресс из стресс-теста (волна 21): шаг «добавь поиск в каталог» с проверкой
// `command: bun run build` принимался как выполненный, хотя страница падала в
// рантайме (`has is not a function`). Спека:
// docs/specs/2026-10-28-turn-runtime-gate-design.md (W1).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  classifyCheck,
  isBehaviorStep,
  parseCheck,
} from "../../src/modules/execution/plan-checks";
import { StepVerifier } from "../../src/modules/execution/verifier";
import { verifyCheckContract } from "../../src/modules/execution/step-check-contract";
import type { PlanToolDeps } from "../../src/modules/execution/plan-tool";

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

  it("file-exists — статика, manual, http и browser — поведение", () => {
    expect(classifyCheck(kindOf("file-exists:src/a.ts"))).toBe("static");
    expect(classifyCheck(kindOf("manual:открыл страницу, видны 6 карточек"))).toBe("behavioral");
    expect(classifyCheck(kindOf("http:http://127.0.0.1:5173/"))).toBe("behavioral");
    expect(classifyCheck(kindOf("http:http://127.0.0.1:5173/~Карточки"))).toBe("behavioral");
    expect(classifyCheck(kindOf("browser:http://127.0.0.1:5173/"))).toBe("behavioral");
    expect(classifyCheck(kindOf("browser:http://127.0.0.1:5173/~Карточки"))).toBe("behavioral");
  });

  it("http:/browser: без url не парсятся", () => {
    expect(parseCheck("http:")).toBeNull();
    expect(parseCheck("browser:")).toBeNull();
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

describe("файловый контракт на поведенческом шаге (F)", () => {
  it("file-exists не доказывает UI-шаг", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "mma-evidence-f-"));
    try {
      mkdirSync(join(baseDir, "src", "app", "catalog"), { recursive: true });
      writeFileSync(
        join(baseDir, "src", "app", "catalog", "page.tsx"),
        "export const x = 1;\n",
      );
      const deps = { baseDir, verifier: new StepVerifier(baseDir) } as PlanToolDeps;
      const res = await verifyCheckContract(
        deps,
        {
          id: 1,
          description: "Создать src/app/catalog/page.tsx",
          status: "pending",
          check: "file-exists:src/app/catalog/page.tsx",
        },
        1,
      );
      expect(res.blocked).not.toBeNull();
      expect(res.blocked!.output).toContain("static evidence");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("file-exists проходит на не-UI шаге", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "mma-evidence-f-"));
    try {
      mkdirSync(join(baseDir, "src"), { recursive: true });
      writeFileSync(join(baseDir, "src", "util.ts"), "export const x = 1;\n");
      const deps = { baseDir, verifier: new StepVerifier(baseDir) } as PlanToolDeps;
      const res = await verifyCheckContract(
        deps,
        {
          id: 1,
          description: "Добавь функцию в src/util.ts",
          status: "pending",
          check: "file-exists:src/util.ts",
        },
        1,
      );
      expect(res.blocked).toBeNull();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
