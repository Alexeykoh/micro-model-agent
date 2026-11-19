// Guard: verify отличает статическое доказательство от поведенческого по
// ДЕКЛАРАЦИИ шага, а не по словам в описании (правило №10 архитектуры).
//
// Регресс из стресс-теста (волна 21) и сессии ses_mwmeoln9: шаг с проверкой
// `command: bun run build` / `file-exists:` принимался как выполненный, хотя
// наблюдаемое поведение было сломано. Спека:
// docs/specs/2026-11-19-evidence-declaration-design.md.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { classifyCheck, parseCheck } from "../../src/modules/execution/plan-checks";
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
    expect(classifyCheck(kindOf("browser:http://127.0.0.1:5173/"))).toBe("behavioral");
  });

  it("http:/browser: без url не парсятся", () => {
    expect(parseCheck("http:")).toBeNull();
    expect(parseCheck("browser:")).toBeNull();
  });
});

describe("декларация поведенческого шага", () => {
  it("file-exists не доказывает шаг с evidence=behavioral", async () => {
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
          evidence: "behavioral",
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

  it("описание с UI-словами без декларации не блокируется", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "mma-evidence-f-"));
    try {
      mkdirSync(join(baseDir, "src"), { recursive: true });
      writeFileSync(join(baseDir, "src", "page.tsx"), "export const x = 1;\n");
      const deps = { baseDir, verifier: new StepVerifier(baseDir) } as PlanToolDeps;
      const res = await verifyCheckContract(
        deps,
        {
          id: 1,
          // Раньше это ловилось по стему "page" — теперь решение за моделью.
          description: "Добавь страницу настроек src/page.tsx",
          status: "pending",
          check: "file-exists:src/page.tsx",
        },
        1,
      );
      expect(res.blocked).toBeNull();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("behavioral + build-команда тоже блокируется", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "mma-evidence-b-"));
    try {
      const deps = { baseDir, verifier: new StepVerifier(baseDir) } as PlanToolDeps;
      const res = await verifyCheckContract(
        deps,
        {
          id: 1,
          description: "Исправь движение игрока",
          status: "pending",
          evidence: "behavioral",
          check: "command:bun run build",
        },
        1,
      );
      expect(res.blocked).not.toBeNull();
      expect(res.blocked!.output).toContain("static evidence");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
