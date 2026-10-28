// Guard: 400 на тело сабмита объясняет, какое поле нужно.
//
// Регресс из стресс-теста (волна 14): `POST /v1/sessions/:id/tasks` с телом
// `{prompt: "..."}` возвращал `{"title":"input required","status":400}` без
// detail — по такому ответу нельзя понять, что схема ждёт `input`.
import { describe, it, expect } from "vitest";
import { parseSubmitBody } from "../../src/modules/service/api/submit-body";

function detailOf(body: Record<string, unknown>): string {
  const r = parseSubmitBody(body);
  expect(r.ok).toBe(false);
  if (r.ok) return "";
  return String(r.problem.detail ?? "");
}

describe("service submit: подсказка про поле", () => {
  it("пустое тело называет обязательное поле input", () => {
    const detail = detailOf({});

    expect(detail).toContain("input");
    expect(detail).toMatch(/required/i);
  });

  it("тело с prompt подсказывает положить текст в input", () => {
    const detail = detailOf({ prompt: "Ответь одним словом: ок" });

    expect(detail).toContain("input");
    expect(detail).toContain("prompt");
  });

  it("корректное тело по-прежнему принимается", () => {
    const r = parseSubmitBody({ input: "ok" });

    expect(r.ok).toBe(true);
  });
});
