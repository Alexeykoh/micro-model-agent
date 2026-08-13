import type { UpdaterConfig } from "../../config/types";
import { Updater, type InstallRunner } from "./checker";
import { t } from "../../i18n/index";
import { pc } from "../../ui/colors";

export interface UpdaterLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Self-update module. Fires an ASYNC (non-blocking) check at startup so the
 * agent never waits on the network. When `autoInstall` is enabled, a newer
 * version is installed globally via `npm install -g` in the background and
 * the user is notified; the running process keeps working on the old version
 * until the next launch.
 */
export class UpdaterModule {
  readonly name = "updater";
  private updater: Updater;
  private config: UpdaterConfig;
  private logger: UpdaterLogger;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Test hook: disable real npm installs. */
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
      warn: (m) => console.warn(pc.yellow(m)),
      error: (m) => console.error(pc.red(m)),
    };
  }

  /** Test hook: prevent the module from actually running npm install. */
  setInstallEnabled(enabled: boolean): void {
    this.installEnabled = enabled;
  }

  getUpdater(): Updater {
    return this.updater;
  }

  isStarted(): boolean {
    return this.started;
  }

  /**
   * Start the background check. Returns immediately (fire-and-forget) so the
   * caller never blocks on the registry. Use `intervalMs > 0` for a permanent
   * re-check loop (the "auto-update daemon" behavior).
   */
  start(): void {
    if (this.started || !this.config.enabled) return;
    this.started = true;
    void this.runLoop();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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

  /** Perform a single check; if an update is available, optionally install it. */
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
        this.logger.info(
          t("updater.installed", { current: result.current, latest: result.latest }),
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
      this.logger.info(
        t("updater.available", { current: result.current, latest: result.latest }),
      );
    }
  }

  private async checkOnce(): Promise<void> {
    await this.runOnce();
  }
}
