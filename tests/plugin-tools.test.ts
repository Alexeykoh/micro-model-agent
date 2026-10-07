// Тулы от плагинов: вклад в реестр, теги, конфликты, выключение, reload,
// синхронизация с клоном реестра сессии (веб) и detach при остановке.
import { describe, it, expect } from "vitest";
import { PluginManager } from "../src/modules/plugins/manager";
import { pluginToolName, pluginToolTag } from "../src/modules/plugins/tools";
import { ToolRegistry } from "../src/tools/registry";
import type { AgentPlugin } from "../src/modules/types";
import type { ToolDefinition } from "../src/tools/types";

/** Плагин, отдающий `names` (каждый — описание «d», handler отвечает именем). */
function toolPlugin(name: string, names: string[]): AgentPlugin {
  return {
    name,
    getToolDefinitions: (): ToolDefinition[] =>
      names.map((tool) => ({
        name: tool,
        description: `${name}:${tool}`,
        parameters: { type: "object", properties: {} },
        handler: (async () => ({ output: tool })) as never,
      })),
    onSessionStart: () => {},
  };
}

function coreTool(name: string): ToolDefinition {
  return { name, description: "core", parameters: { type: "object", properties: {} } };
}

/** Пара «главный менеджер + клон сессии» с общим гейтом и плагином `demo`. */
function mainAndRunner(): {
  main: PluginManager;
  runner: PluginManager;
  runnerRegistry: ToolRegistry;
} {
  const main = new PluginManager();
  main.register(toolPlugin("demo", ["ping"]));
  const runner = new PluginManager();
  runner.shareGateWith(main);
  runner.register(toolPlugin("demo", ["ping"]));
  const runnerRegistry = new ToolRegistry();
  runner.attachToolRegistry(runnerRegistry);
  return { main, runner, runnerRegistry };
}

describe("plugin tools — вклад в реестр", () => {
  it("кладёт тул под plugin__<плагин>__<тул> с тегом и provides", () => {
    const manager = new PluginManager();
    const plugin = toolPlugin("demo", ["ping", "pong"]);
    manager.register(plugin);
    const registry = new ToolRegistry();
    manager.attachToolRegistry(registry);

    const names = registry.list();
    expect(names).toEqual([pluginToolName("demo", "ping"), pluginToolName("demo", "pong")]);
    const ping = registry.get(pluginToolName("demo", "ping"));
    expect(ping?.tags).toContain(pluginToolTag("demo"));
    // alwaysOn по умолчанию: иначе enable_tools спрятал бы тул плагина.
    expect(ping?.alwaysOn).toBe(true);
    // provides.tools заполняет ядро — оттуда его берут UI и `mma plugins show`.
    expect(manager.getRecords()[0].provides.tools).toEqual(names);
  });

  it("сохраняет авторские теги и явный alwaysOn: false", () => {
    const manager = new PluginManager();
    manager.register({
      name: "tagged",
      getToolDefinitions: () => [
        {
          name: "t",
          description: "d",
          parameters: {},
          tags: ["meta"],
          alwaysOn: false,
          handler: (async () => ({ output: "x" })) as never,
        },
      ],
    });
    const registry = new ToolRegistry();
    manager.attachToolRegistry(registry);
    const def = registry.get(pluginToolName("tagged", "t"));
    expect(def?.tags).toEqual(["meta", pluginToolTag("tagged")]);
    expect(def?.alwaysOn).toBe(false);
  });

  it("выключение плагина снимает тул, включение возвращает", () => {
    const manager = new PluginManager();
    manager.register(toolPlugin("demo", ["ping"]));
    const registry = new ToolRegistry();
    manager.attachToolRegistry(registry);
    const name = pluginToolName("demo", "ping");
    expect(registry.has(name)).toBe(true);

    manager.setEnabled("demo", false);
    expect(registry.has(name)).toBe(false);

    manager.setEnabled("demo", true);
    expect(registry.has(name)).toBe(true);
  });

  it("выгрузка плагина снимает его тулы", () => {
    const manager = new PluginManager();
    manager.register(toolPlugin("demo", ["ping"]));
    const registry = new ToolRegistry();
    manager.attachToolRegistry(registry);
    expect(manager.unregister("demo")).toBe(true);
    expect(registry.list()).toEqual([]);
  });

  it("reload плагина перерегистрирует определение", () => {
    const manager = new PluginManager();
    manager.register(toolPlugin("demo", ["ping"]));
    const registry = new ToolRegistry();
    manager.attachToolRegistry(registry);
    const name = pluginToolName("demo", "ping");
    expect(registry.get(name)?.description).toBe("demo:ping");

    manager.unregister("demo");
    manager.register(toolPlugin("demo", ["ping"]));
    expect(registry.get(name)?.description).toBe("demo:ping");
    expect(registry.list()).toEqual([name]);
  });
});

describe("plugin tools — контракт результата", () => {
  it("результат без success считается успешным (плагин пишется на JS)", async () => {
    // Живой прогон: хендлер вернул {output} — тул честно выглядел упавшим
    // (в логе не было `success`, Trace показывал false).
    const manager = new PluginManager();
    manager.register({
      name: "lazy",
      getToolDefinitions: () => [
        {
          name: "t",
          description: "d",
          parameters: {},
          handler: (async () => ({ output: "ok" })) as never,
        },
      ],
    });
    const registry = new ToolRegistry();
    manager.attachToolRegistry(registry);
    const def = registry.get(pluginToolName("lazy", "t"));
    const result = await def!.handler({} as never, {});
    expect(result).toEqual({ output: "ok", success: true });
  });

  it("явный success:false и нестроковый output не теряются", async () => {
    const manager = new PluginManager();
    manager.register({
      name: "odd",
      getToolDefinitions: () => [
        {
          name: "t",
          description: "d",
          parameters: {},
          handler: (async () => ({ success: false, output: { code: 7 } })) as never,
        },
      ],
    });
    const registry = new ToolRegistry();
    manager.attachToolRegistry(registry);
    const def = registry.get(pluginToolName("odd", "t"));
    const result = await def!.handler({} as never, {});
    expect(result.success).toBe(false);
    expect(result.output).toBe('{"code":7}');
  });

  it("тул без handler отклоняется с внятной диагностикой, а не падает в рантайме", () => {
    const manager = new PluginManager();
    manager.register({
      name: "nohandler",
      getToolDefinitions: () => [{ name: "t", description: "d", parameters: {} } as never],
    });
    const registry = new ToolRegistry();
    const result = manager.attachToolRegistry(registry);
    expect(registry.list()).toEqual([]);
    expect(result.conflicts[0].detail).toContain("handler");
  });
});

describe("plugin tools — отказ вклада", () => {
  it("конфликт с ядром отбрасывает весь вклад плагина, хуки живы", () => {
    const manager = new PluginManager();
    let hookCalls = 0;
    manager.register({
      ...toolPlugin("demo", ["ping", "pong"]),
      onBuildPrompt: () => {
        hookCalls++;
        return null;
      },
    });
    const registry = new ToolRegistry();
    // Ядро уже заняло одно из имён — вклад плагина не частичный, а целиком.
    registry.upsert(coreTool(pluginToolName("demo", "pong")));
    const result = manager.attachToolRegistry(registry);

    expect(registry.has(pluginToolName("demo", "ping"))).toBe(false);
    expect(result.conflicts.map((c) => c.plugin)).toEqual(["demo"]);
    expect(manager.getToolConflicts()[0].reason).toBe("conflict");
    // Хуки плагина продолжают работать.
    manager.runOnBuildPrompt();
    expect(hookCalls).toBe(1);
  });

  it("невалидное определение не роняет синхронизацию", () => {
    const manager = new PluginManager();
    manager.register({
      name: "broken",
      getToolDefinitions: () => [{ name: "ok", description: "d", parameters: {} }, null as never],
    });
    const registry = new ToolRegistry();
    const result = manager.attachToolRegistry(registry);
    expect(registry.has(pluginToolName("broken", "ok"))).toBe(false);
    expect(result.conflicts.some((c) => c.reason === "invalid")).toBe(true);
  });

  it("выброшенный getToolDefinitions изолирован (бросок не роняет харнесс)", () => {
    const manager = new PluginManager();
    manager.register({
      name: "angry",
      getToolDefinitions: () => {
        throw new Error("boom");
      },
    });
    const registry = new ToolRegistry();
    expect(() => manager.attachToolRegistry(registry)).not.toThrow();
    expect(registry.list()).toEqual([]);
  });

  it("мусор в provides.tools не показывается как «добавляет тулы»", () => {
    const manager = new PluginManager();
    const plugin = toolPlugin("demo", ["ping"]);
    manager.register(plugin);
    const registry = new ToolRegistry();
    manager.attachToolRegistry(registry);
    // Плагин снял свои тулы и отдаёт мусор — UI не должен обещать старый набор.
    plugin.getToolDefinitions = () => [null as never];
    manager.attachToolRegistry(registry);
    expect(manager.getRecords()[0].provides.tools).toEqual([]);
  });
});

describe("plugin tools — несколько реестров (сессии веба)", () => {
  it("вклад уходит и в главный реестр, и в клон сессии", () => {
    const manager = new PluginManager();
    manager.register(toolPlugin("demo", ["ping"]));
    const main = new ToolRegistry();
    const runner = new ToolRegistry();
    manager.attachToolRegistry(main);
    manager.attachToolRegistry(runner);
    const name = pluginToolName("demo", "ping");
    expect(main.has(name)).toBe(true);
    expect(runner.has(name)).toBe(true);

    manager.setEnabled("demo", false);
    expect(main.has(name)).toBe(false);
    expect(runner.has(name)).toBe(false);
  });

  it("reload из главного менеджера доезжает до клона сессии", () => {
    // Живой прогон: правка плагина не доезжала до уже спавненной сессии —
    // клон держал старый инстанс и его определения тулов.
    const { main, runnerRegistry } = mainAndRunner();
    const name = pluginToolName("demo", "ping");
    expect(runnerRegistry.get(name)?.description).toBe("demo:ping");

    main.unregister("demo");
    main.register(toolPlugin("demo", ["ping"]));
    expect(runnerRegistry.get(name)?.description).toBe("demo:ping");
  });

  it("удалённый файл плагина убирает его из клона сессии", () => {
    const { main, runner, runnerRegistry } = mainAndRunner();

    main.unregister("demo");
    expect(runnerRegistry.list()).toEqual([]);
    expect(runner.getRecords().map((r) => r.name)).toEqual([]);
  });

  it("свой execution-плагин раннера не растаскивается по главному", () => {
    // Регистрация в follower'е не рассылается: иначе plugin раннера заменил бы
    // собой одноимённый плагин главного агента.
    const main = new PluginManager();
    const runner = new PluginManager();
    runner.shareGateWith(main);
    runner.register(toolPlugin("execution", ["verify"]));
    expect(main.getRecords().map((r) => r.name)).toEqual([]);
    expect(runner.getRecords().map((r) => r.name)).toEqual(["execution"]);
  });

  it("клон реестра сессии не считается коллизией с ядром", () => {
    // Живой прогон: buildRunnerRegistry клонирует определения, и клон приходит
    // без записи о владельце — вклад плагина отбрасывался, и reload не обновлял
    // тул (работала старая копия из клона).
    const main = new PluginManager();
    main.register(toolPlugin("demo", ["ping"]));
    const mainRegistry = new ToolRegistry();
    main.attachToolRegistry(mainRegistry);

    const runnerRegistry = mainRegistry.clone(); // как buildRunnerRegistry
    const runner = new PluginManager();
    runner.shareGateWith(main);
    runner.register(toolPlugin("demo", ["ping"]));
    const result = runner.attachToolRegistry(runnerRegistry);

    expect(result.conflicts).toEqual([]);
    expect(runnerRegistry.get(pluginToolName("demo", "ping"))).toBeDefined();

    // Выключение вычищает клон (иначе тул выключенного плагина жил бы в сессии).
    main.setEnabled("demo", false);
    expect(runnerRegistry.list()).toEqual([]);
  });

  it("общий deny-list: тумблер главного менеджера гасит тул в клоне сессии", () => {
    const { main, runner, runnerRegistry } = mainAndRunner();
    const name = pluginToolName("demo", "ping");
    expect(runnerRegistry.has(name)).toBe(true);

    // Выключение пришло от мейна (веб-тумблер → setConfigValue → site-effect).
    main.setEnabled("demo", false);
    expect(runnerRegistry.has(name)).toBe(false);
    // Кэш записей раннера тоже увидел смену гейта.
    expect(runner.getRecords()[0].enabled).toBe(false);
  });

  it("detach снимает тул с реестра и прекращает следить за ним", () => {
    const manager = new PluginManager();
    manager.register(toolPlugin("demo", ["ping"]));
    const registry = new ToolRegistry();
    manager.attachToolRegistry(registry);
    const name = pluginToolName("demo", "ping");

    manager.detachToolRegistry(registry);
    expect(registry.has(name)).toBe(false);

    // Плагин загрузился позже — в отключённый реестр он попадать не должен.
    manager.register(toolPlugin("second", ["pong"]));
    expect(registry.list()).toEqual([]);
  });
});
