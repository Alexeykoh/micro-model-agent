// Встроенный `telegram-notify`: выключен по умолчанию, манифест, гейты.
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config/defaults";
import { PluginManager } from "../src/modules/plugins/manager";
import { validateSettingsSchema } from "../src/modules/plugins/settings-schema";
import { buildRecord } from "../src/modules/plugins/records";
import { plugin as telegramNotifyPlugin } from "../src/modules/plugins/builtin/telegram-notify";
import { TelegramNotifyPlugin } from "../src/modules/plugins/builtin/telegram-notify";
import { TELEGRAM_NOTIFY_SCHEMA } from "../src/modules/plugins/builtin/plugin-settings";
import {
  resolveChatId,
  turnMessage,
  type FetchJson,
} from "../src/modules/plugins/builtin/telegram-notify-client";

function throwingFetch(): FetchJson {
  return () => {
    throw new Error("network must not be touched");
  };
}

const ctxOf = () =>
  ({ logger: { debug: () => {}, warn: () => {} } }) as unknown as Parameters<
    TelegramNotifyPlugin["onTurnEnd"]
  >[0];
const summaryOf = (patch = {}) =>
  ({ success: true, durationMs: 1000, toolCalls: 2, ...patch }) as Parameters<
    TelegramNotifyPlugin["onTurnEnd"]
  >[1];

describe("telegram-notify plugin — default disabled", () => {
  it("is in the default plugins deny-list", () => {
    expect(DEFAULTS.plugins?.disabled).toContain("telegram-notify");
  });

  it("registers but stays inactive until enabled through the deny-list", () => {
    const pm = new PluginManager();
    pm.register(telegramNotifyPlugin);
    pm.setDisabledAll(DEFAULTS.plugins?.disabled ?? []);
    expect(pm.isEnabled("telegram-notify")).toBe(false);
    pm.setDisabledAll([]);
    expect(pm.isEnabled("telegram-notify")).toBe(true);
  });
});

describe("telegram-notify plugin — manifest", () => {
  it("declares a valid settings schema", () => {
    const { defs, warnings } = validateSettingsSchema(TELEGRAM_NOTIFY_SCHEMA);
    expect(warnings).toEqual([]);
    expect(defs.map((d) => d.key)).toEqual([
      "botToken",
      "chatId",
      "notifyOn",
      "sessionId",
      "sessionName",
    ]);
  });

  it("has a settings subpage (builtin, no path needed)", () => {
    const record = buildRecord(telegramNotifyPlugin, { enabled: true });
    expect(record.hasSettings).toBe(true);
  });
});

describe("telegram-notify plugin — gating", () => {
  it("skips sending without a bot token", async () => {
    const plugin = new TelegramNotifyPlugin(throwingFetch());
    plugin.onTurnEnd(ctxOf(), summaryOf());
    await new Promise((r) => setTimeout(r, 20));
  });

  it("builds a turn message with status and details", () => {
    const text = turnMessage(
      { id: "s1", name: "chat" },
      { success: false, durationMs: 1500, toolCalls: 3 },
      { branch: "dev", provider: "openai", model: "m", text: "done" },
      "boom",
    );
    expect(text).toContain("❌");
    expect(text).toContain("Сессия: chat (s1)");
    expect(text).toContain("Ветка: dev");
    expect(text).toContain("Ошибка: boom");
    expect(text).toContain("done");
  });
});

describe("resolveChatId", () => {
  it("takes the last chat from getUpdates and caches it", async () => {
    const written: string[] = [];
    const fetchImpl: FetchJson = async () => ({
      result: [{ message: { chat: { id: 111 } } }],
    });
    const id = await resolveChatId(fetchImpl, "token", {
      read: () => null,
      write: (chatId) => void written.push(chatId),
    });
    expect(id).toBe("111");
    expect(written).toEqual(["111"]);
  });
});

describe("telegram-notify plugin — isolated settings dir", () => {
  it("reads settings from an isolated config dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-tg-"));
    const { telegramNotifySettings } = await import(
      "../src/modules/plugins/builtin/plugin-settings"
    );
    expect(telegramNotifySettings(dir)).toMatchObject({ notifyOn: "turn", botToken: "" });
  });
});
