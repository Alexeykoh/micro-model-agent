// Модуль самообновления: фоновая проверка при старте, опциональная автоустановка.
import type { UpdaterConfig } from "../../config/types";
import { Updater, type InstallResult } from "./checker";
import type { InstallProgress } from "./install-release";
import { extractLatestChangelog, readChangelog } from "./changelog-reader";
import { installFailureText } from "./messages";
import { installScriptCommand } from "./release";
import { t } from "../../i18n/index";
import { pc } from "../../ui/colors";
import { defaultOutputBus } from "../../output";

/** Логгер модуля (по умолчанию — шина вывода). */
export interface UpdaterLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** Фаза, о которой уведомляет модуль: есть апдейт / ставится / поставлен / провал. */
export type UpdatePhase = "available" | "installing" | "installed" | "failed";

/** Событие апдейтера для наружных поверхностей (SSE/UI). */
export interface UpdateNotice {
  phase: UpdatePhase;
  current: string;
  latest?: string;
  error?: string;
  /** Прогресс установки (только `installing`). */
  progress?: InstallProgress;
}

/**
 * Модуль самообновления. При старте — АСИНХРОННАЯ (неблокирующая) проверка,
 * чтобы агент никогда не ждал сеть. При включённом `autoInstall` свежая версия
 * скачивается из GitHub Releases и активируется (`~/.mma/current`) в фоне,
 * пользователь уведомляется; запущенный процесс до следующего старта работает
 * на старой версии.
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
  /** Резолвер `idlePromise`: `stop()` не оставляет висеть мёртвый таймер. */
  private idleResolve: (() => void) | null = null;
  /** Резолвер паузы между проверками (его будит `stop()`). */
  private wake: (() => void) | null = null;
  /** Защита от параллельных установок (`POST /api/update` и фон). */
  private installing = false;
  /** Тест-хук: отключает реальные установки. */
  private installEnabled = true;

/**
   * Наблюдатель за результатом проверки/установки. Терминал его не ставит (ему
   * хватает логгера), веб-режим — ставит, чтобы отдать факт в SSE: там никто не
   * смотрит в stdout, и без этого апдейт работал бы полностью молча.
   */
  private onNotice?: (notice: UpdateNotice) => void;

  constructor(
    config: UpdaterConfig,
    updater: Updater,
    logger?: UpdaterLogger,
    onNotice?: (notice: UpdateNotice) => void,
  ) {
    this.config = config;
    this.updater = updater;
    this.onNotice = onNotice;
    this.logger = logger ?? {
      info: () => {},
      warn: (m) => defaultOutputBus.log("warn", "module:updater", m),
      error: (m) => defaultOutputBus.log("error", "module:updater", m),
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

  /**
   * Ручная установка (кнопка «Update» в web/CLI): логирует старт и итог, шлёт
   * прогресс и финальный `notice` наружу. `autoInstall`-путь отличается лишь
   * триггером; общая точка — `runOnce`. Возвращает результат установки.
   */
  async installNow(): Promise<InstallResult> {
    const current = this.updater.getCurrentVersion();
    if (!this.installEnabled) {
      return { success: false, error: "update install is not available in this mode" };
    }
    if (this.installing) {
      return { success: false, error: "update install is already in progress" };
    }
    this.installing = true;
    try {
      const check = await this.updater.check();
      const latest = check.latest ?? "";
      this.logger.info(t("updater.installing", { current, latest: latest || "latest" }));
      this.onNotice?.({ phase: "installing", current, latest });
      const leftover: string[] = [];
      const result = await this.updater.install(
        (progress) => {
          this.onNotice?.({ phase: "installing", current, latest, progress });
        },
        (names) => leftover.push(...names),
      );
      if (result.success) this.reportInstalled(current, result.installed ?? latest, leftover);
      else this.reportFailed(current, latest, result.error ?? "");
      return result;
    } finally {
      this.installing = false;
    }
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
    this.idlePromise = new Promise<void>((resolve) => {
      this.idleResolve = resolve;
    });
    void this.runLoop().finally(() => this.finishIdle());
  }

  /** Останавливает фоновый цикл и снимает таймер; idle резолвится сразу. */
  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.wake?.();
    this.finishIdle();
  }

  /** Резолвит `idlePromise` (идемпотентно): ждать мёртвый таймер больше не нужно. */
  private finishIdle(): void {
    this.idleResolve?.();
    this.idleResolve = null;
  }

  /**
   * Ждёт устаканивания текущего цикла check/install, но не дольше timeoutMs.
   * `true` — цикл завершён, `false` — истёк таймаут. No-op → `true`, если
   * модуль не стартовал.
   */
  async waitForIdle(timeoutMs = 130000): Promise<boolean> {
    const idle = this.idlePromise;
    if (!idle) return true;
    const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs));
    return await Promise.race([idle.then(() => true as const), timeout]);
  }

  private async runLoop(): Promise<void> {
    while (this.started) {
      await this.checkOnce();
      if (!this.started) return;
      if (this.config.intervalMs > 0) {
        await this.pause(this.config.intervalMs);
      } else {
        this.started = false;
      }
    }
  }

  /** Пауза между проверками; `stop()` будит её через `this.wake`. */
  private pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = () => {
        this.wake = null;
        resolve();
      };
      this.timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
    });
  }

  /** Одна проверка; при доступном апдейте — опциональная установка. */
  async runOnce(): Promise<void> {
    const result = await this.updater.check();
    if (result.error) {
      this.logger.warn(t("updater.check_error", { error: result.error }));
      return;
    }
    const { current, latest } = result;
    if (!result.updateAvailable || !latest) return;
    if (this.config.autoInstall && this.installEnabled) await this.autoInstall(current, latest);
    else this.notifyAvailable(current, latest);
  }

  /** Скачивает и активирует свежую версию, репортит успех/провал. */
  private async autoInstall(current: string, latest: string): Promise<void> {
    if (this.installing) return;
    this.installing = true;
    try {
      this.logger.info(t("updater.installing", { current, latest }));
      const leftover: string[] = [];
      const install = await this.updater.install(undefined, (names) => leftover.push(...names));
      if (install.success) this.reportInstalled(current, latest, leftover);
      else this.reportFailed(current, latest, install.error ?? "");
    } finally {
      this.installing = false;
    }
  }

  private reportInstalled(current: string, latest: string, leftover: string[] = []): void {
    const changelog = readChangelog("micro-models-agent");
    const latestEntry = changelog ? extractLatestChangelog(changelog) : null;
    const changelogBlock = latestEntry
      ? pc.cyan(`\n${t("cli.changelog_title", { version: latest })}\n`) + latestEntry
      : "";
    this.logger.info(t("updater.installed", { current, latest, changelog: changelogBlock }));
    // Новая версия уже активна; занятый каталог старой — не провал обновления.
    // Строка идёт уровнем ниже (info → detail), чтобы не спорить с успехом.
    if (leftover.length > 0) {
      this.logger.info(t("updater.cleanup_deferred", { versions: leftover.join(", ") }));
    }
    this.onNotice?.({ phase: "installed", current, latest });
  }

  private reportFailed(current: string, latest: string, error: string): void {
    const root = this.updater.getInstallRoot();
    // В чат — причина и одна команда; сырой `EACCES: …, rm '…'` остаётся
    // диагностикой в session-логе (info не виден в терминале по умолчанию).
    this.logger.warn(installFailureText(latest, error, root));
    this.logger.info(t("updater.install_failed_detail", { error }));
    this.onNotice?.({ phase: "failed", current, latest, error });
  }

  /** Дефолт `autoInstall: false`: сообщение с подсказкой, как обновиться. */
  private notifyAvailable(current: string, latest: string): void {
    this.logger.warn(
      t("updater.available", {
        current,
        latest,
        hint: t("updater.auto_install_hint", { cmd: installScriptCommand() }),
      }),
    );
    this.onNotice?.({ phase: "available", current, latest });
  }

  private async checkOnce(): Promise<void> {
    await this.runOnce();
  }
}
