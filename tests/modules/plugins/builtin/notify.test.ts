import { NotifyPlugin } from "../../../../src/modules/plugins/builtin/notify";

describe("NotifyPlugin", () => {
  it("logs session end at debug level with the session id", () => {
    const plugin = new NotifyPlugin();
    const debug: string[] = [];
    const info: string[] = [];
    const mockCtx = {
      sessionId: "ses_abc",
      logger: {
        debug: (msg: string) => debug.push(msg),
        info: (msg: string) => info.push(msg),
      },
    } as never;

    plugin.onSessionEnd!(mockCtx);

    // Диагностика жизненного цикла: на уровне info она превращалась в
    // неразличимый шум на каждый interrupt (14 строк на один ход).
    expect(info.length).toBe(0);
    expect(debug.length).toBe(1);
    expect(debug[0]).toContain("ses_abc");
  });

  it("tolerates a logger without debug (minimal/legacy contexts)", () => {
    const plugin = new NotifyPlugin();
    const info: string[] = [];
    const mockCtx = { sessionId: "ses_x", logger: { info: (m: string) => info.push(m) } } as never;

    expect(() => plugin.onSessionEnd!(mockCtx)).not.toThrow();
  });
});
