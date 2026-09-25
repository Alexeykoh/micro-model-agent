import { describe, it, expect, afterEach } from "vitest";
import { createWebUiState, } from "../src/modules/webui/state";
import { DEFAULTS } from "../src/config/defaults";
import { getFlatDicts, setLocale, t } from "../src/i18n";
import { configDefs } from "../src/config/registry";
import type { AppConfig } from "../src/config/types";
import { withServer, postJson, doFetch, } from "./helpers/webui-server";



function testConfig(): AppConfig {
  const config = structuredClone(DEFAULTS);
  config.locale = "en";
  return config;
}


describe("webui i18n", () => {
  afterEach(() => setLocale("en"));

  it("GET /api/i18n returns the current locale + en/ru flat dicts", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/i18n`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        locale: string;
        dicts: Record<string, Record<string, string>>;
      };
      expect(body.locale).toBe("en");
      expect(body.dicts.en["web.topbar.new_chat"]).toBe("new chat");
      expect(body.dicts.ru["web.topbar.new_chat"]).toBe("новый чат");
      // Flattened: dotted keys are top-level entries, not nested objects.
      expect(typeof body.dicts.en["web.settings.general"]).toBe("string");
    });
  });

  it("GET /api/i18n reports the configured locale", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    s.config.locale = "ru";
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/i18n`);
      const body = (await res.json()) as { locale: string };
      expect(body.locale).toBe("ru");
    });
  });

  it("POST /api/config {locale} applies setLocale process-wide", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    s.saveConfig = () => {};
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/config", { key: "locale", value: "ru" });
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(s.config?.locale).toBe("ru");
      // The registry key has `reconfigure: false`, so the endpoint must call
      // `setLocale` itself — otherwise nothing switches server-side.
      expect(t("web.topbar.new_chat")).toBe("новый чат");
    });
  });

  it("keeps en/ru parity for every web.* key", () => {
    const dicts = getFlatDicts();
    const enKeys = Object.keys(dicts.en).filter((k) => k.startsWith("web."));
    const ruKeys = Object.keys(dicts.ru).filter((k) => k.startsWith("web."));
    expect(enKeys.length).toBeGreaterThan(0);
    expect([...enKeys].sort()).toEqual([...ruKeys].sort());
  });

  it("keeps en/ru parity for every config.* key", () => {
    const dicts = getFlatDicts();
    const isConfig = (k: string) => k.startsWith("config.key.") || k.startsWith("config.enum.");
    const enKeys = Object.keys(dicts.en).filter(isConfig);
    const ruKeys = Object.keys(dicts.ru).filter(isConfig);
    expect(enKeys.length).toBeGreaterThan(0);
    expect([...enKeys].sort()).toEqual([...ruKeys].sort());
  });

  it("translates every registry key and enum value in both locales", () => {
    const dicts = getFlatDicts();
    for (const def of configDefs()) {
      const key = `config.key.${def.key}`;
      expect(typeof dicts.en[key], `${key} (en)`).toBe("string");
      expect(typeof dicts.ru[key], `${key} (ru)`).toBe("string");
      for (const value of def.enumValues ?? []) {
        const ek = `config.enum.${value}`;
        expect(typeof dicts.en[ek], `${ek} (en)`).toBe("string");
        expect(typeof dicts.ru[ek], `${ek} (ru)`).toBe("string");
      }
    }
  });

  it("returns 503-free empty locale when config is not wired", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/i18n`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { locale: string };
      expect(body.locale).toBe("en");
    });
  });
});
