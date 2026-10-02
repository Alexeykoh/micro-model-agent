import { describe, it, expect, afterEach } from "vitest";
import { createWebUiState, } from "../src/modules/webui/state";
import { DEFAULTS } from "../src/config/defaults";
import { getFlatDicts, setLocale, t } from "../src/i18n/index";
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

  it("GET /api/i18n reports whether server dicts are stale (ses_mup6p61q)", async () => {
    // Словари на диске новее процесса — клиент показывает бейдж рестарта,
    // иначе сырые ключи вместо подписей. В тестовом прогоне файлы из
    // checkout старше процесса, но формально проверяем только форму флага.
    const s = createWebUiState();
    s.config = testConfig();
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/i18n`);
      const body = (await res.json()) as { i18nStale: boolean };
      expect(typeof body.i18nStale).toBe("boolean");
    });
  });

  it("stale-banner keys resolve in both locales (no raw keys in chrome)", () => {
    // Регрессия F1: ключи были потеряны `git checkout --` при живой проверке
    // и ни один тест не заметил — бейдж показывал бы сырые ключи.
    const dicts = getFlatDicts();
    for (const key of ["web.i18n.stale", "web.i18n.reload"]) {
      expect(typeof dicts.en[key], `${key} (en)`).toBe("string");
      expect(typeof dicts.ru[key], `${key} (ru)`).toBe("string");
    }
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

  it("translates every registry key and enum value in both locales", () => {    const dicts = getFlatDicts();
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

  it("names every settings panel in both locales", async () => {
    // Menu items + panel headers render via t("web.settings." + data-p); a
    // missing key leaks the raw key into the UI (seen with network/… panels).
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(
      new URL("../src/modules/webui/assets/index.html", import.meta.url),
      "utf-8",
    );
    const panels = [...html.matchAll(/data-p="([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(panels.length).toBeGreaterThan(10);
    const dicts = getFlatDicts();
    for (const p of new Set(panels)) {
      const key = `web.settings.${p}`;
      expect(typeof dicts.en[key], `${key} (en)`).toBe("string");
      expect(typeof dicts.ru[key], `${key} (ru)`).toBe("string");
    }
  });

  it("titles and explains every settings section in both locales", async () => {
    // settings-controls.js is DOM-coupled (via dom.js) — parse the section
    // table out of the source instead of importing it. `settings.js` adds a few
    // section titles inline, so scan it too (and `config.field.*` labels).
    const { readFileSync } = await import("node:fs");
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");
    const src = read("../src/modules/webui/assets/js/settings-controls.js");
    const settingsSrc = read("../src/modules/webui/assets/js/settings.js");
    const titles = [
      ...[...src.matchAll(/titleKey:\s*"(web\.settings\.[a-z0-9.-]+)"/g)].map((m) => m[1]),
      ...[...settingsSrc.matchAll(/"(web\.settings\.sec\.[a-z0-9.-]+)"/g)].map((m) => m[1]),
    ];
    const descs = [...src.matchAll(/descKey:\s*"(web\.settings\.[a-z0-9.-]+)"/g)].map((m) => m[1]);
    const fields = [
      "name",
      "model",
      "tool_tags",
      "max_attempts",
      "description",
      "input",
      "output",
      "cachedInput",
      "cacheWrite",
      "vision",
      "tools",
    ].map((f) => `config.field.${f}`);
    expect(titles.length).toBeGreaterThan(20);
    expect(descs.length).toBeGreaterThan(15);
    const dicts = getFlatDicts();
    for (const key of new Set([...titles, ...descs, ...fields])) {
      expect(typeof dicts.en[key], `${key} (en)`).toBe("string");
      expect(typeof dicts.ru[key], `${key} (ru)`).toBe("string");
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
