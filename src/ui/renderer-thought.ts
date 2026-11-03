// Блок мысли: открытие по фазе thinking, dim-тело, длительность на закрытии.
import type { OutputChannel } from "../output";
import { t } from "../i18n/index";
import { pc } from "./colors";
import { formatDuration, glyph } from "./theme";

/**
 * Состояние блока рассуждений. Заголовок печатается лениво — только когда
 * появилось тело; пустой блок длительности не печатает.
 */
export class ThoughtBlock {
  private started = false;
  private startMs = 0;
  private headerPrinted = false;
  private label = "";
  /** Чередует короткие человеческие ярлыки, чтобы повторы thinking не звучали роботно. */
  private count = 0;

  constructor(private readonly channel: OutputChannel) {}

  /** Открыт ли блок (между thinkingStart и закрытием). */
  get isOpen(): boolean {
    return this.started;
  }

  /** Начинает новую фазу; возвращает ярлык для спиннера. */
  begin(): string {
    this.started = true;
    this.startMs = Date.now();
    this.headerPrinted = false;
    this.label = this.nextLabel();
    return this.label;
  }

  /**
   * Печатает заголовок `✦ <акцентный ярлык> · ` один раз за фазу. Безопасно
   * звать на каждом чанке: тело идёт следом dim-текстом.
   */
  ensureHeader(): void {
    if (!this.started || this.headerPrinted) return;
    this.channel.writeRaw(
      `\n${pc.magenta(glyph.thinking)} ${pc.magenta(this.label)} ${pc.dim("·")} `,
    );
    this.headerPrinted = true;
  }

  /**
   * Закрывает блок с печатью длительности. Безопасно звать многократно: и
   * финальный ответ, и следующий тул требуют закрытого блока.
   */
  finish(): void {
    if (this.started && this.headerPrinted) {
      const duration = Date.now() - this.startMs;
      this.channel.writeRaw(pc.dim(` ${formatDuration(duration)}\n`));
    }
    this.started = false;
    this.headerPrinted = false;
  }

  /** Первая фаза всегда канонична `ui.thinking_label` (стабильно в тестах/скринах). */
  private nextLabel(): string {
    const index = this.count++;
    const key = index === 0 ? "ui.thinking_label" : `ui.thinking_label_${(index % 3) + 1}`;
    const value = t(key);
    return value !== key ? value : t("ui.thinking_label");
  }
}
