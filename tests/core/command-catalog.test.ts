import { describe, it, expect } from "vitest";
import { COMMAND_CATALOG } from "../../src/core/commands/spec";
import {
  CommandRegistry,
  groupCommands,
  parseCommandLine,
  isAvailable,
} from "../../src/core/commands/catalog";

/**
 * Каталог команд — декларативная часть реестра. Он заменил две вещи, которые
 * раньше расходились молча: таблицу `COMMAND_GROUPS` (29 строк, синхронизировалась
 * вручную) и рукописный список `HELP` в `mma web`.
 *
 * Тесты фиксируют инварианты, из-за которых каталог вообще полезен: разбор ввода
 * и фильтрация по поверхности едины для всех фронтендов, а объявление команды
 * не может появиться без описания/группы/поверхности.
 */

function registry(): CommandRegistry {
  return new CommandRegistry(COMMAND_CATALOG);
}

/**
 * `/clear` и `/new` помечены `web`, но разбираются на клиенте
 * (`assets/js/session/composer.ts`), а не в серверном диспатчере, — в списке
 * хендлеров их нет по устройству, а не по забывчивости.
 */
const CLIENT_SIDE_WEB = new Set(["clear", "new"]);

describe("каталог команд", () => {
  it("объявляет уникальные имена без ведущего слэша", () => {
    const names = COMMAND_CATALOG.map((c) => c.name);
    for (const name of names) {
      expect(name).not.toMatch(/^\//);
      expect(name).toBe(name.toLowerCase());
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it("у каждой команды есть описание и группа из известного набора", () => {
    const groups = new Set(["general", "agent", "session", "skill"]);
    for (const c of COMMAND_CATALOG) {
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.group ?? "general").toBeTruthy();
      if (c.group) expect(groups.has(c.group)).toBe(true);
    }
  });

  it("алиасы не пересекаются с каноническими именами и уникальны", () => {
    const names = new Set(COMMAND_CATALOG.map((c) => c.name));
    const aliases: string[] = [];
    for (const c of COMMAND_CATALOG) {
      for (const alias of c.aliases ?? []) {
        expect(names.has(alias)).toBe(false);
        aliases.push(alias);
      }
    }
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("команда, помеченная web, не теряется в терминальной справке", () => {
    // `/sessions` в браузере называется `/session` (webName) и остаётся
    // терминальной командой: каталог описывает обе поверхности, а не одну.
    const sessions = COMMAND_CATALOG.find((c) => c.name === "sessions");
    expect(sessions?.webName).toBe("session");
    expect(isAvailable(sessions!, "terminal")).toBe(true);
    expect(isAvailable(sessions!, "web")).toBe(true);
  });

  it("каталог покрывает ровно те команды, которые реально регистрирует REPL", () => {
    // Главный анти-дрейф-тест: команда, добавленная в `registerCommand`, но не
    // в каталог, выпадает из `/help` (и из TUI-реестра) молча. Сверяем
    // объявления `name:` во всех файлах регистрации с каталогом.
    const sources = [
      "src/cli/repl-commands.ts",
      "src/cli/onboarding-commands.ts",
      "src/cli/repl-commands-lsp.ts",
      "src/cli/repl-commands-skills.ts",
      "src/cli/repl-commands-doctor.ts",
    ].map(readCommandSources);
    const registered = new Set<string>();
    for (const src of sources) {
      for (const m of src.matchAll(/\n\s{4}name: "([^"]+)",/g)) registered.add(m[1]);
    }
    const catalogued = new Set(COMMAND_CATALOG.map((c) => c.name));
    expect(registered.size).toBeGreaterThan(20);
    expect([...registered].filter((n) => !catalogued.has(n))).toEqual([]);
    expect([...catalogued].filter((n) => !registered.has(n))).toEqual([]);
  });

  it("команды, помеченные web, действительно поддержаны вебом", () => {
    // Веб-диспатчер объявляет свой набор (webui/chat/commands*.ts). Проверяем
    // по источнику, чтобы каталог не обещал браузеру несуществующие команды.
    const webSource =
      readCommandSources("src/modules/webui/chat/commands.ts") +
      readCommandSources("src/modules/webui/settings/commands-settings.ts");
    const declaredInWeb = (c: (typeof COMMAND_CATALOG)[number]): boolean => {
      const names = [c.webName ?? c.name, ...(c.aliases ?? [])];
      return names.some((n) => new RegExp(`^\\s{4}${n}:`, "m").test(webSource));
    };
    for (const c of COMMAND_CATALOG) {
      const expected = declaredInWeb(c) || CLIENT_SIDE_WEB.has(c.name);
      expect(
        isAvailable(c, "web"),
        `команда /${c.name}: surfaces=${JSON.stringify(c.surfaces)}, ` +
          `веб-диспатчер=${declaredInWeb(c)}`,
      ).toBe(expected);
    }
  });
});

describe("CommandRegistry", () => {
  it("резолвит каноническое имя и алиасы в одну запись", () => {
    const r = registry();
    for (const alias of ["exit", "quit", "q"]) {
      expect(r.resolve(alias)?.name).toBe("exit");
    }
    expect(r.resolve("/Exit")?.name).toBe("exit");
    expect(r.resolve("nope")).toBeUndefined();
  });

  it("bind вешает действие на все ключи команды и не теряет описание", () => {
    const r = registry();
    const calls: string[][] = [];
    r.bind("exit", (args) => {
      calls.push(args);
    });
    for (const key of ["exit", "quit", "q"]) {
      r.resolve(key)?.action?.(["x"], () => {});
    }
    expect(calls).toEqual([["x"], ["x"], ["x"]]);
    // Описание и usage пережили приклейку действия.
    expect(r.resolve("q")?.description).toBeTruthy();
    expect(r.resolve("q")?.usage).toBeTruthy();
  });

  it("list отдаёт канонические команды без дублей алиасов", () => {
    const all = registry().list();
    expect(all.map((c) => c.name)).toContain("exit");
    expect(all.filter((c) => c.name === "exit")).toHaveLength(1);
  });

  it("фильтрует по поверхности: терминал не получает web-only команды", () => {
    const r = registry();
    const terminal = r.list("terminal").map((c) => c.name);
    const web = r.list("web").map((c) => c.name);
    // `run`/`image` — только терминал (картинки из буфера, `/run` как команда).
    expect(terminal).toContain("run");
    expect(web).not.toContain("run");
    expect(web).not.toContain("image");
    // `sysprompt`/`lsp`/`meet` — терминальные, веба нет.
    expect(terminal).toContain("sysprompt");
    expect(web).not.toContain("sysprompt");
    expect(web).not.toContain("meet");
    // Общие команды есть на обоих.
    expect(terminal).toContain("config");
    expect(web).toContain("config");
  });

  it("isAvailable: без surfaces команда доступна терминалу и TUI, но не вебу", () => {
    const spec = COMMAND_CATALOG.find((c) => c.name === "run")!;
    expect(isAvailable(spec, "terminal")).toBe(true);
    expect(isAvailable(spec, "tui")).toBe(true);
    expect(isAvailable(spec, "web")).toBe(false);
  });

  it("tui получает терминальный набор целиком — точка подключения будущего TUI", () => {
    const tui = new CommandRegistry(COMMAND_CATALOG).list("tui").map((c) => c.name);
    const terminal = new CommandRegistry(COMMAND_CATALOG).list("terminal").map((c) => c.name);
    expect(tui).toEqual(terminal);
    expect(tui).toContain("config");
    expect(tui).toContain("status");
    expect(tui).toContain("sessions");
  });
});

describe("groupCommands", () => {
  it("группирует в заданном порядке и пропускает пустые группы", () => {
    const groups = groupCommands(registry().list(), "terminal");
    expect(groups.map((g) => g.group)).toEqual(["general", "agent", "session", "skill"]);
    for (const g of groups) expect(g.entries.length).toBeGreaterThan(0);
    const sessionNames = groups.find((g) => g.group === "session")!.entries.map((e) => e.name);
    expect(sessionNames).toContain("resume");
  });
});

describe("parseCommandLine", () => {
  it("режет ввод одинаково для всех фронтендов", () => {
    expect(parseCommandLine("/config model gpt")).toEqual({ name: "config", args: ["model", "gpt"] });
    expect(parseCommandLine("  /Config   model  ")).toEqual({ name: "config", args: ["model"] });
    expect(parseCommandLine("config model")).toBeNull();
    expect(parseCommandLine("/")).toBeNull();
  });

  it("разобранное имя резолвится реестром (сквозной путь ввода → исполнение)", () => {
    const parsed = parseCommandLine("/q")!;
    expect(registry().resolve(parsed.name)?.name).toBe("exit");
  });
});

function readCommandSources(path: string): string {
  // Bun/Node: синхронное чтение без импорта ради строкового контракта.
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return readFileSync(path, "utf8");
}