// Guard: `mma session export --out -` обязан отдавать в stdout только документ.
//
// Регресс из стресс-теста (волна 17): WARN стартовой проверки («системному
// промпту нужно ~14739 токенов…») шёл в stdout перед JSON, и `| jq` падал на
// `Unexpected character 'W'`. `config show` при этом печатал чистый JSON — один
// и тот же принцип соблюдался в одном месте и забывался в другом.
import { describe, it, expect, afterEach } from "vitest";
import { OutputChannel } from "../../src/output/channel";
import { OutputBus, setLogsToStderr } from "../../src/output/bus";

afterEach(() => setLogsToStderr(false));

function collector(): { lines: string[]; stream: NodeJS.WritableStream } {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write: (chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      },
    } as unknown as NodeJS.WritableStream,
  };
}

function makeChannel() {
  const out = collector();
  const err = collector();
  const bus = new OutputBus();
  const channel = new OutputChannel(bus, { out: out.stream, err: err.stream, color: false });
  return { bus, channel, out, err };
}

describe("канал вывода: диагностика отдельно от машинного документа", () => {
  it("с setLogsToStderr(true) log идёт в stderr, блок — в stdout", () => {
    const { bus, channel, out, err } = makeChannel();
    setLogsToStderr(true);

    bus.emit({ level: "warn", source: "mma", kind: "log", text: "[WARN] budget" });
    bus.emit({ level: "info", source: "mma", kind: "block", text: '{"ok":true}' });

    expect(err.lines.join("")).toContain("budget");
    expect(out.lines.join("")).toContain('{"ok":true}');
    expect(out.lines.join("")).not.toContain("[WARN]");
    // stdout остаётся валидным JSON-документом.
    expect(() => JSON.parse(out.lines.join("").trim())).not.toThrow();
  });

  it("по умолчанию log остаётся в stdout (прежнее поведение)", () => {
    setLogsToStderr(false);
    const { bus, channel, out, err } = makeChannel();

    bus.emit({ level: "warn", source: "mma", kind: "log", text: "[WARN] budget" });

    expect(out.lines.join("")).toContain("[WARN]");
    expect(err.lines.join("")).toBe("");
  });
});
