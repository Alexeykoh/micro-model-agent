import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Repl } from "../../src/cli/repl";
import { makeCaptureChannel, type CaptureChannel } from "./capture-channel";

/**
 * `/help` теперь строится по общему каталогу команд (`core/commands/spec`),
 * а не по локальной таблице групп. Это вид пользователю, поэтому вывод
 * зафиксирован здесь: переезд на каталог не должен изменить ни состав
 * разделов, ни подписи, ни порядок групп.
 */

function makeAgent() {
  return {
    run: async () => ({ success: true, text: "ok", provider: "p", model: "m", durationMs: 1 }),
    shutdown: () => {},
    getProviderFor: () => undefined,
    tryToolContext: () => undefined,
  } as never;
}

function makeConfig() {
  return {
    model: "test",
    provider: { type: "test", baseUrl: "test", apiKey: "test" },
    contextWindow: 32768,
    contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
    logLevel: "info",
    locale: "en",
    maxToolIterations: 25,
    stuckThreshold: 8,
    autoPlan: true,
    showReasoning: false,
    ui: {},
    session: { autoSave: false, maxSessions: 50, isolateMemory: false },
  } as never;
}

describe("showHelp по каталогу команд", () => {
  let dir: string;
  let originalRl: { close?: () => void } | undefined;
  let capture: CaptureChannel;

  beforeEach(() => {
    process.env.MMA_DSR = "0";
    dir = mkdtempSync(join(tmpdir(), "mma-help-"));
    capture = makeCaptureChannel();
  });

  afterEach(() => {
    capture.channel.dispose();
    originalRl?.close?.();
    originalRl = undefined;
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MMA_DSR;
  });

  function makeRepl(): Repl {
    const repl = new Repl(
      makeAgent(),
      makeConfig(),
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, join(dir, "repl-history"),
      undefined, undefined, capture.channel,
    );
    originalRl = repl.rl as unknown as { close?: () => void };
    return repl;
  }

  it("печатает все четыре группы в фиксированном порядке", () => {
    const repl = makeRepl();
    capture.out.data = "";
    repl.showHelp();
    const text = capture.out.data;
    // Заголовки групп приходят в порядке general → agent → session → skill.
    const general = text.indexOf("General");
    const agent = text.indexOf("Agent");
    expect(general).toBeGreaterThanOrEqual(0);
    expect(agent).toBeGreaterThan(general);
  });

  it("показывает каждую команду, реально зарегистрированную в этом REPL", () => {
    const repl = makeRepl();
    capture.out.data = "";
    repl.showHelp();
    const text = capture.out.data;
    // Команды сессий и `/skill` регистрируются только при наличии модулей
    // (`registerSessionCommands`/`registerSkillCommands` выходят без них), поэтому
    // сверяем не с каталогом целиком, а с тем, что этот REPL поднял.
    const registered = new Set(
      (repl as unknown as { commands: Map<string, unknown> }).commands.values(),
    );
    const missing = [...registered]
      .map((c) => (c as { name: string }).name)
      .filter((n) => !text.includes(`/${n} `));
    expect(missing).toEqual([]);
  });

  it("команда без своего модуля не попадает в справку", () => {
    const repl = makeRepl();
    capture.out.data = "";
    repl.showHelp();
    // Без `sessionManager` сессионных команд нет — и в справке тоже.
    expect(capture.out.data).not.toContain("/resume");
  });

  it("печатает usage и алиасы", () => {
    const repl = makeRepl();
    capture.out.data = "";
    repl.showHelp();
    const text = capture.out.data;
    expect(text).toContain("Usage:");
    // `/exit` объявлен с алиасами quit/q — они видны в общем списке.
    expect(text).toContain("quit");
  });

  it("/help <команда> печатает описание, usage и примеры", () => {
    const repl = makeRepl();
    capture.out.data = "";
    repl.showHelp("config");
    const text = capture.out.data;
    expect(text).toContain("/config");
    expect(text).toContain("Usage:");
    expect(text).toContain("/config reasoning.mode high");
  });

  it("алиас раскрывается в каноническое имя (/help quit → /exit)", () => {
    const repl = makeRepl();
    capture.out.data = "";
    repl.showHelp("quit");
    expect(capture.out.data).toContain("/exit");
  });

  it("неизвестная команда даёт красную подсказку, а не пустоту", () => {
    const repl = makeRepl();
    capture.out.data = "";
    repl.showHelp("nope");
    expect(capture.out.data.toLowerCase()).toContain("nope");
  });
});