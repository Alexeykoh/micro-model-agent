/**
 * Точность маскирования секретов (спека
 * `2026-10-20-dlp-secret-masking-precision-design.md`, INV-S1/S2).
 *
 * Тест падал бы до правки: детектор брал паттерны лог-санитайзера, из-за чего
 * обычный код (`password === confirmPassword`) превращался в `[SECRET]`, а
 * идентификатор ключа съедался маской (`OPENAI_[SECRET]`).
 */
import { describe, it, expect } from "vitest";
import { createGuard } from "../../src/modules/security/data-policy/guard";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";
import type { DataPolicyConfig } from "../../src/modules/security/data-policy/types";

const ctx: PolicyContext = {
  baseDir: "C:\\work\\proj",
  home: "C:\\Users\\alex",
  hostname: "DESKTOP-ABC123",
  username: "alex",
  env: { USERNAME: "alex" },
};

const cfg: DataPolicyConfig = { ...DEFAULT_DATA_POLICY };

/** Прогнать текст через guard доверенной (локальной) цели и вернуть результат. */
function local(text: string, config: DataPolicyConfig = cfg): string {
  const guard = createGuard({
    config,
    target: { kind: "provider", trusted: true, host: "localhost" },
    ctx,
  });
  const r = guard.sanitizeChat([{ role: "user", content: text }]);
  return String((r.messages as Array<{ content: string }>)[0].content);
}

describe("INV-S1: секрет — это значение, а не идентификатор", () => {
  it("сравнение паролей — не секрет", () => {
    const src = "if (password === confirmPassword) { login(); }";
    expect(local(src)).toBe(src);
  });

  it("ссылка на переменную окружения — не секрет", () => {
    const src = "secret: process.env.CLIENT_SECRET,";
    expect(local(src)).toBe(src);
  });

  it("идентификатор без значения — не секрет", () => {
    const src = "const token = jwt.sign(payload, key);";
    expect(local(src)).toBe(src);
  });

  it("имя переменной в строке — не секрет", () => {
    const src = "headers.set('X-Api-Key', apiKey)";
    expect(local(src)).toBe(src);
  });

  it("настоящий ключ редактируется", () => {
    const out = local("api_key=sk-abcdefghij0123456789");
    expect(out).not.toContain("sk-abcdefghij0123456789");
  });

  it("короткий литерал в кавычках — секрет", () => {
    const out = local("password: 'hunter2'");
    expect(out).not.toContain("hunter2");
  });

  it("Bearer-токен редактируется, префикс остаётся", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln";
    const out = local(`Authorization: Bearer ${token}`);
    expect(out).not.toContain(token);
    expect(out).toContain("Bearer");
  });
});

describe("INV-S2: маска сохраняет идентификатор", () => {
  it("структура key=value остаётся разбираемой", () => {
    const out = local("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).toBe("OPENAI_API_KEY=[SECRET]");
  });

  it("уже отредактированное значение не пере-редактируется", () => {
    const src = "OPENAI_API_KEY=[REDACTED]";
    expect(local(src)).toBe(src);
  });

  it("код остаётся синтаксически разбираемым", () => {
    const src = "export function login(password: string, confirmPassword: string) { return password === confirmPassword; }";
    expect(local(src)).toBe(src);
  });
});

describe("INV-S6: политика доверенных не меняется", () => {
  it("секрет прячется даже от локального провайдера", () => {
    const out = local("api_key=sk-abcdefghij0123456789");
    expect(out).not.toContain("sk-abcdefghij0123456789");
  });
});

describe("INV-S5: маскирование секретов выключается ключом", () => {
  it("egress.secrets=false — секреты не редактируются", () => {
    const src = "api_key=sk-abcdefghij0123456789";
    const out = local(src, { ...cfg, egress: { ...cfg.egress, secrets: false } });
    expect(out).toBe(src);
  });

  it("путь и PII при этом всё ещё редактируются для внешней цели", () => {
    const guard = createGuard({
      config: { ...cfg, egress: { ...cfg.egress, secrets: false } },
      target: { kind: "provider", trusted: false, host: "api.example.com" },
      ctx,
    });
    const r = guard.sanitizeChat([{ role: "user", content: "open C:\\work\\proj\\src\\a.ts" }]);
    expect(JSON.stringify(r.messages)).not.toContain("C:\\work\\proj");
  });

  it("конфиг без нового ключа ведёт себя как раньше (секреты прячем)", () => {
    const src = "api_key=sk-abcdefghij0123456789";
    const out = local(src, {
      ...cfg,
      egress: { ...cfg.egress, secrets: undefined as unknown as boolean },
    });
    expect(out).not.toContain("sk-abcdefghij0123456789");
  });
});

describe("INV-S3: токен восстанавливается независимо от регистра", () => {
  const external = () =>
    createGuard({
      config: cfg,
      target: { kind: "provider", trusted: false, host: "api.example.com" },
      ctx,
    });

  it("hex в верхнем регистре — тот же токен", () => {
    const g = external();
    const src = "open C:\\work\\proj\\src\\a.ts";
    const projected = String(
      (g.sanitizeChat([{ role: "user", content: src }]).messages as Array<{ content: string }>)[0]
        .content,
    );
    const token = projected.match(/<PATH:[0-9a-f]+>/)?.[0] ?? "";
    expect(token).not.toBe("");
    expect(g.rehydrateArgs(token.toUpperCase())).toBe("C:\\work\\proj");
  });

  it("чужая метка не восстанавливается", () => {
    const g = external();
    expect(g.rehydrateArgs("<PATH:deadbeefdeadbeef>")).toBe("<PATH:deadbeefdeadbeef>");
  });
});
