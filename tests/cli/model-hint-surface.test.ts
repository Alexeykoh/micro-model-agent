// Guard: подсказка в CLI не отправляет пользователя в REPL-форму команды.
//
// Регресс из стресс-теста (волна 18): `mma model list` заканчивался строкой
// «(Используйте /model use <имя> для смены)» — в терминале такой команды нет,
// вызывать нужно `mma model use <имя>`. В REPL подсказка `/model use` остаётся
// верной, поэтому ключи разведены.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { t } from "../../src/i18n/index";

describe("model list: подсказка соответствует поверхности", () => {
  it("CLI-ключ говорит про mma model use, а не про /model use", () => {
    const cliHint = t("cli.model_hint_cli");

    expect(cliHint).toMatch(/mma model use/);
    expect(cliHint).not.toMatch(/\/model use/);
  });

  it("REPL-ключ по-прежнему про /model use", () => {
    expect(t("cli.model_hint")).toMatch(/\/model use/);
  });

  it("CLI печатает cli.model_hint_cli, REPL — cli.model_hint", () => {
    const cli = readFileSync("src/cli/commands.ts", "utf8");
    const repl = readFileSync("src/cli/repl-commands.ts", "utf8");

    expect(cli).toContain('t("cli.model_hint_cli")');
    expect(cli).not.toContain('t("cli.model_hint")');
    expect(repl).toContain('t("cli.model_hint")');
  });
});
