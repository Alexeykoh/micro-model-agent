// Модуль самообновления: фоновая проверка при старте, опциональная автоустановка.
import type { UpdaterConfig } from "../../config/types";
import { Updater, type InstallRunner } from "./checker";
import { extractLatestChangelog, readChangelog } from "./changelog-reader";
import { t } from "../../i18n/index";
import { pc } from "../../ui/colors";
import { defaultOutputBus } from "../../output";

/** Логгер модуля (по умолчанию — шина вывода). */
export interface UpdaterLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Модуль самообновления. При старте — АСИНХРОННАЯ (неблокирующая) проверка,
 * чтобы агент никогда не ждал сеть. При включённом `autoInstall` свежая версия
 * ставится глобально через `npm install -g` в фоне, пользователь уведомляется;
 * запущенный процесс до следующего старта работает на старой версии.
 */
export class UpdaterModule {
  readonly name = "updater";
  private updater: Updater;
  private config: UpdaterConfig;
  private logger: UpdaterLogger;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Промис текущего витка run-loop (резолвится по устаканиванию). */
  private idlePromise: Promise<void> | null = null;
  /** Тест-хук: отключает реальные npm-установки. */
  private installEnabled = true;

  constructor(
    config: UpdaterConfig,
    currentVersion: string,
    packageName: string,
    logger?: UpdaterLogger,
    installRunner?: InstallRunner,
  ) {
    this.config = config;
    this.updater = new Updater(currentVersion, packageName, installRunner);
    this.logger = logger ?? {
      info: () => {},
      warn: (m) => defaultOutputBus.log("warn", "updater", m),
      error: (m) => defaultOutputBus.log("error", "updater", m),
    };
  }

  /** Тест-хук: запрещает модулю реально гонять npm install. */
  setInstallEnabled(enabled: boolean): void {
    this.installEnabled = enabled;
  }

  /** Доступ к underlying-апдейтеру (версия, пакет). */
  getUpdater(): Updater {
    return this.updater;
  }

  /** True, если фоновая проверка запущена. */
  isStarted(): boolean {
    return this.started;
  }

  /**
   * Стартует фоновую проверку. Возвращается сразу (fire-and-forget), чтобы
   * вызывающий не ждал реестр. `intervalMs > 0` — вечный цикл перепроверок
   * (поведение "auto-update daemon").
   */
  start(): void {
    if (this.started || !this.config.enabled) return;
    this.started = true;
    this.idlePromise = this.runLoop();
  }

  /** Останавливает фоновый цикл и снимает таймер. */
  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Ждёт устаканивания текущего цикла check/install, но не дольше timeoutMs.
   * Нужно one-shot CLI-прогонам, чтобы фоновый `npm install -g` не убивался
   * process.exit() до завершения. No-op, если модуль не стартовал.
   */
  async waitForIdle(timeoutMs = 130000): Promise<void> {
    const idle = this.idlePromise;
    if (!idle) return;
    await Promise.race([idle, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  private async runLoop(): Promise<void> {
    while (this.started) {
      await this.checkOnce();
      if (!this.started) return;
      if (this.config.intervalMs > 0) {
        await new Promise((r) => (this.timer = setTimeout(r, this.config.intervalMs)));
      } else {
        this.started = false;
      }
    }
  }

  /** Одна проверка; при доступном апдейте — опциональная установка. */
  async runOnce(): Promise<void> {
    const result = await this.updater.check();
    if (result.error) {
      this.logger.info(t("updater.check_error", { error: result.error }));
      return;
    }
    if (!result.updateAvailable || !result.latest) return;

    if (this.config.autoInstall && this.installEnabled) {
      this.logger.info(
        t("updater.installing", {
          current: result.current,
          latest: result.latest,
        }),
      );
      const install = await this.updater.install(result.latest);
      if (install.success) {
        const changelog = readChangelog("micro-models-agent");
        const latestEntry = changelog ? extractLatestChangelog(changelog) : null;
        const changelogBlock = latestEntry
          ? pc.cyan(`\n${t("cli.changelog_title", { version: result.latest })}\n`) + latestEntry
          : "";
        this.logger.info(
          t("updater.installed", {
            current: result.current,
            latest: result.latest,
            changelog: changelogBlock,
          }),
        );
      } else {
        this.logger.warn(
          t("updater.install_failed", {
            current: result.current,
            latest: result.latest,
            error: install.error ?? "",
          }),
        );
      }
    } else {
      this.logger.info(t("updater.available", { current: result.current, latest: result.latest }));
    }
  }

  private async checkOnce(): Promise<void> {
    await this.runOnce();
  }
}
