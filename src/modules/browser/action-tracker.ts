// Трекер повторов действий браузера: одна и та же тройка (action,args,url)
// подряд — повод предупредить модель, а не жать те же кнопки бесконечно.
import { t } from "../../i18n/index";

/** Ловит N одинаковых действий подряд на одном URL и возвращает предупреждение. */
export class BrowserActionTracker {
  private history: Array<{
    action: string;
    args: Record<string, unknown>;
    url: string;
  }> = [];
  private threshold: number;

  constructor(threshold = 3) {
    this.threshold = threshold;
  }

  /** Записать действие; при серии повторов — текст предупреждения, иначе null. */
  record(action: string, args: Record<string, unknown>, url: string): string | null {
    this.history.push({ action, args, url });

    if (this.history.length < this.threshold) return null;

    const recent = this.history.slice(-this.threshold);
    const allSame = recent.every(
      (h) =>
        h.action === recent[0].action &&
        h.url === recent[0].url &&
        JSON.stringify(h.args) === JSON.stringify(recent[0].args),
    );

    if (allSame) {
      return t("browser.repeated_action", {
        action,
        threshold: this.threshold,
      });
    }

    return null;
  }

  /** Сбросить историю (вызывается при open). */
  reset(): void {
    this.history = [];
  }
}
