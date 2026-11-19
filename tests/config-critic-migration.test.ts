import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "../src/config/config";
import { DEFAULTS } from "../src/config/defaults";
import { LLM_REQUEST_TIMEOUT_MS } from "../src/config/timeouts";
import {
  LEGACY_CRITIC_TIMEOUT_MS,
  checkCriticTimeout,
  migratePersistedCriticTimeout,
} from "../src/config/migrate-legacy";

/**
 * Миграция устаревшего `critic.timeoutMs` (W1).
 *
 * Реальная поломка: домен `critic` авто-персистится ЦЕЛИКОМ, поэтому старый
 * дефолт 15 с переживал смену дефолта и переписывался при каждом сохранении.
 * Итог — критик обрывался на 15-й секунде (раньше провайдерского дедлайна) и
 * молча fail-open'ился: «проверил и сказал ок» неотличимо от «не дождался».
 */
describe("critic timeout migration (W1)", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  function makeTempDir(): string {
    const d = mkdtempSync(join(tmpdir(), "mma-critic-cfg-"));
    tmpDirs.push(d);
    return d;
  }

  /** Персист домена `critic` в конфиг-домене (config/critic.json). */
  function writeCriticDomain(configDir: string, critic: Record<string, unknown>): void {
    mkdirSync(join(configDir, "config"), { recursive: true });
    writeFileSync(join(configDir, "config", "critic.json"), JSON.stringify({ critic }));
  }

  it("migrates the legacy auto-default timeout in the domain file", () => {
    const dir = makeTempDir();
    writeCriticDomain(dir, {
      enabled: true,
      tools: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      timeoutMs: LEGACY_CRITIC_TIMEOUT_MS,
    });

    const { config } = loadConfig({
      configDir: dir,
      projectConfigPath: join(dir, ".mmrc"),
    });

    expect(config.critic.timeoutMs).toBe(DEFAULTS.critic.timeoutMs);
    // Инвариант «обёртка живет дольше запроса» теперь держится и на реальном
    // персисте, а не только на DEFAULTS.
    expect(config.critic.timeoutMs).toBeGreaterThan(LLM_REQUEST_TIMEOUT_MS);
    expect(checkCriticTimeout(config).tooShort).toBe(false);
  });

  it("migrates the legacy auto-default timeout in the legacy config.json", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        version: "2.0.0",
        critic: { enabled: true, maxCalls: 4, maxRepairCycles: 1, timeoutMs: 15000 },
      }),
    );

    const { config } = loadConfig({
      configDir: dir,
      projectConfigPath: join(dir, ".mmrc"),
    });

    expect(config.critic.timeoutMs).toBe(DEFAULTS.critic.timeoutMs);
  });

  it("migrates the legacy auto-default timeout in the project .mmrc", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, ".mmrc"),
      JSON.stringify({ critic: { enabled: true, maxCalls: 4, maxRepairCycles: 1, timeoutMs: 15000 } }),
    );

    const { config } = loadConfig({
      configDir: dir,
      projectConfigPath: join(dir, ".mmrc"),
    });

    expect(config.critic.timeoutMs).toBe(DEFAULTS.critic.timeoutMs);
  });

  it("keeps a deliberately configured short timeout (D7: user's choice)", () => {
    const dir = makeTempDir();
    // Своя модель → домен не «исторический авто-дефолт» → не трогаем.
    writeCriticDomain(dir, {
      enabled: true,
      model: "my-judge",
      maxCalls: 4,
      maxRepairCycles: 1,
      timeoutMs: LEGACY_CRITIC_TIMEOUT_MS,
    });

    const { config } = loadConfig({
      configDir: dir,
      projectConfigPath: join(dir, ".mmrc"),
    });

    expect(config.critic.timeoutMs).toBe(LEGACY_CRITIC_TIMEOUT_MS);
    // Короткий таймаут виден: check помечает его как tooShort.
    expect(checkCriticTimeout(config).tooShort).toBe(true);
  });

  it("keeps a custom timeout that differs from the legacy default", () => {
    const dir = makeTempDir();
    writeCriticDomain(dir, { enabled: true, timeoutMs: 45_000 });

    const { config } = loadConfig({
      configDir: dir,
      projectConfigPath: join(dir, ".mmrc"),
    });

    expect(config.critic.timeoutMs).toBe(45_000);
    expect(checkCriticTimeout(config).tooShort).toBe(true);
  });

  it("leaves the default config alone", () => {
    const dir = makeTempDir();
    const { config } = loadConfig({
      configDir: dir,
      projectConfigPath: join(dir, ".mmrc"),
    });

    expect(config.critic.timeoutMs).toBe(DEFAULTS.critic.timeoutMs);
    expect(config.critic.timeoutMs).toBeGreaterThan(LLM_REQUEST_TIMEOUT_MS);
  });

  it("migratePersistedCriticTimeout only touches the legacy auto-default", () => {
    // Сырой персист без домена — ничего.
    expect(migratePersistedCriticTimeout(undefined).migrated).toBe(false);
    expect(migratePersistedCriticTimeout({}).migrated).toBe(false);

    // Свой maxCalls — не авто-дефолт.
    const custom = { critic: { timeoutMs: LEGACY_CRITIC_TIMEOUT_MS, maxCalls: 2 } };
    expect(migratePersistedCriticTimeout(custom).migrated).toBe(false);
    expect(custom.critic.timeoutMs).toBe(LEGACY_CRITIC_TIMEOUT_MS);

    // Авто-дефолт — мигрирует.
    const legacy = { critic: { timeoutMs: LEGACY_CRITIC_TIMEOUT_MS } };
    const state = migratePersistedCriticTimeout(legacy);
    expect(state.migrated).toBe(true);
    expect(state.from).toBe(LEGACY_CRITIC_TIMEOUT_MS);
    expect(state.to).toBe(DEFAULTS.critic.timeoutMs);
    expect(legacy.critic.timeoutMs).toBe(DEFAULTS.critic.timeoutMs);
  });
});
