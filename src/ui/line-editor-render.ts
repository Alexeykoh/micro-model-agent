/**
 * Рендер кадра редактора и DSR-якорь курсора. Вынесено из `line-editor.ts`
 * (правило 6); escape-последовательности, таймауты и скролл-математика
 * перенесены без изменений — терминальный протокол чувствителен.
 */
import stringWidth from "string-width";
import {
  buildLayout,
  layoutIndexFor,
  visualColAt,
  charLen,
  stripAnsi,
  type LayoutRow,
} from "./line-math";
import { readEnv } from "../config/env";
import type { LineBuffer } from "./line-editor-buffer";
import type { EditorOutput } from "./line-editor-types";

/** Рисует кадр промпта и ведёт абсолютный якорь (DSR, `ESC[6n`). */
export class LineRenderer {
  /** Визуальный ряд (внутри рисуемого кадра), куда последний рендер поставил
   *  курсор. Фолбэк для возврата на первую строку кадра перед перерисовкой,
   *  пока нет абсолютного якоря. Относительные ходы ломаются при скролле
   *  терминала (кадр уезжает вверх, счётчик — нет), что дублировало
   *  многострочный ввод. */
  private prevCursorRow = 0;
  /** Абсолютный 1-based экранный ряд первой визуальной строки кадра. Выучен
   *  из одного DSR-ответа о позиции курсора (`ESC[6n`), шлётся раз на показ
   *  промпта. Дальше якорь ведётся детерминированной скролл-математикой, новых
   *  запросов нет (защита от рассинхрона ConPTY). Без ответа (таймаут/битый
   *  терминал) — фолбэк на относительные ходы. */
  private frameTopAbs: number | null = null;
  /** Ждём ли DSR-ответ (ровно один outstanding-запрос). */
  private dsrPending = false;
  /** Буфер частичных DSR-escape, разрезанных между чанками. */
  private dsrTail = "";
  /** Визуальный ряд курсора ровно в момент отправки outstanding DSR-запроса.
   *  Ответ матчится против него, а не `prevCursorRow`: промежуточные рендеры
   *  перезаписывают тот, пока запрос ещё летит. */
  private dsrQueryRow = 0;
  /** Сбрасывает `dsrPending`, если DSR-ответ не пришёл: фолбэк на относительные
   *  ходы вместо клина на битом терминале. */
  private dsrTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly buf: LineBuffer,
    private readonly output: EditorOutput,
    private readonly prompt: () => string,
  ) {}

  columns(): number {
    return this.output.columns || 80;
  }

  /** Абсолютный верх кадра (для тестов/диагностики редактора). */
  get frameTop(): number | null {
    return this.frameTopAbs;
  }
  set frameTop(value: number | null) {
    this.frameTopAbs = value;
  }

  /** Outstanding DSR-запрос (для тестов/диагностики редактора). */
  get awaitingDsr(): boolean {
    return this.dsrPending;
  }

  /** Визуальный ряд курсора на момент DSR-запроса (для тестов). */
  get queryRow(): number {
    return this.dsrQueryRow;
  }

  /** Визуальный ряд курсора последнего рендера (для тестов). */
  get cursorRow(): number {
    return this.prevCursorRow;
  }

  layout(): LayoutRow[] {
    const promptWidth = stringWidth(stripAnsi(this.prompt()));
    return buildLayout(this.buf.lines, this.columns(), Math.max(1, this.columns() - promptWidth));
  }

  /** 1-based высота терминала, null — неизвестна (тесты / не-TTY). */
  screenRows(): number | null {
    const r = (this.output as { rows?: number }).rows;
    return typeof r === "number" && r > 3 ? r : null;
  }

  /**
   * Можно ли слать запрос позиции курсора (`ESC[6n`). На Windows — opt-in:
   * ConPTY может декодировать ответ `ESC[row;colR` как ввод, что портит ответы
   * (визард настройки отвечал на каждый промпт "R").
   * `MMA_DSR=1` форсит вкл, `MMA_DSR=0` — выкл; иначе по умолчанию вкл.
   */
  dsrEnabled(): boolean {
    if (readEnv("DSR") === "1") return true;
    if (readEnv("DSR") === "0") return false;
    return process.platform !== "win32";
  }

  /** Режет рисуемый кадр до видимого экрана. Кадр выше терминала нельзя
   *  перерисовать на месте (верх уехал в скролл), так что рисуется только хвост;
   *  абсолютный якорь держит следующий рендер консистентным в любом случае. */
  visibleLayout(): LayoutRow[] {
    const layout = this.layout();
    const H = this.screenRows();
    const maxRows = H ? H - 2 : 0;
    if (maxRows > 0 && layout.length > maxRows) {
      return layout.slice(layout.length - maxRows);
    }
    return layout;
  }

  /** Забывает выученную абсолютную позицию кадра: курсор прыгнул в неизвестное
   *  место (внешний вывод, чистка экрана, свежий промпт). Следующий рендер
   *  переспросит через DSR. */
  invalidate(): void {
    this.frameTopAbs = null;
    this.dsrPending = false;
    this.dsrTail = "";
    this.prevCursorRow = 0;
    if (this.dsrTimer) {
      clearTimeout(this.dsrTimer);
      this.dsrTimer = null;
    }
  }

  /** Отменяет отложенный DSR-таймаут (вызывается при закрытии редактора). */
  dispose(): void {
    if (this.dsrTimer) {
      clearTimeout(this.dsrTimer);
      this.dsrTimer = null;
    }
  }

  /** Парсит DSR-ответы `ESC[row;colR`. Буферит разрезанные escape между чанками.
   *  Принимает максимум один ответ (outstanding-запрос); лишние молча дропаются.
   *  Строку валидирует против `screenRows()`, отсекая неправдоподобные значения ConPTY. */
  consumeDsr(chunk: string): void {
    this.dsrTail = (this.dsrTail + chunk).slice(-80);
    const m = /\x1b\[(\d+);(\d+)R/.exec(this.dsrTail);
    if (!m) return;
    this.dsrTail = "";
    if (!this.dsrPending) return;
    this.dsrPending = false;
    const row = Number(m[1]);
    if (this.dsrTimer) {
      clearTimeout(this.dsrTimer);
      this.dsrTimer = null;
    }
    // Верх кадра = строка ответа минус визуальный ряд курсора на момент запроса.
    // `dsrQueryRow`, а не `prevCursorRow`: промежуточные рендеры могли двинуть
    // курсор, пока запрос летел.
    const top = row - this.dsrQueryRow;
    const H = this.screenRows();
    if (top >= 1 && (H === null || top <= H)) this.frameTopAbs = top;
  }

  /** Собирает кадр для записи в output: возврат на верх, строки, курсор. */
  buildFrame(): { text: string; layoutLen: number; idx: number } {
    const layout = this.visibleLayout();
    const promptWidth = stringWidth(stripAnsi(this.prompt()));
    const idx = layoutIndexFor(layout, this.buf.row, this.buf.col);
    const vcol = visualColAt(layout, idx, this.buf.col);
    const rowsAfter = layout.length - idx - 1;
    const ccol = (idx === 0 ? promptWidth : 0) + vcol;

    const out: string[] = [];
    // Возврат на первую строку кадра перед перерисовкой. Абсолютное
    // позиционирование (выученное одним DSR-запросом на промпт) иммунно к
    // скроллу; относительные ходы вверх — фолбэк до прихода первого ответа.
    if (this.frameTopAbs !== null) {
      out.push(`\x1b[${this.frameTopAbs};1H`);
    } else if (this.prevCursorRow > 0) {
      out.push(`\x1b[${this.prevCursorRow}A`);
      out.push("\r");
    } else {
      out.push("\r");
    }
    for (let i = 0; i < layout.length; i++) {
      out.push("\x1b[2K");
      if (i === 0) out.push(this.prompt());
      out.push(layout[i].text);
      if (i < layout.length - 1) out.push("\r\n");
    }
    out.push("\x1b[J");
    if (rowsAfter > 0) out.push(`\x1b[${rowsAfter}A`);
    out.push("\r");
    if (ccol > 0) out.push(`\x1b[${ccol}C`);
    return { text: out.join(""), layoutLen: layout.length, idx };
  }

  /**
   * Детерминированная скролл-математика после записи кадра: обновляет якорь для
   * СЛЕДУЮЩЕГО рендера и, если якоря ещё нет, шлёт один DSR-запрос.
   */
  afterRender(layoutLen: number, idx: number, questionActive: boolean): void {
    this.prevCursorRow = idx;
    // После записи L строк от frameTopAbs терминал скроллится, если кадр вылез за
    // низ экрана; новый верх кадра считается локально, новых DSR-запросов не надо.
    if (this.frameTopAbs !== null) {
      const H = this.screenRows();
      if (H) {
        const T = this.frameTopAbs;
        const L = layoutLen;
        if (T + L - 1 > H) this.frameTopAbs = H - L + 1;
        // else: no scroll, anchor unchanged
      }
    } else if (!this.dsrPending && !questionActive && this.dsrEnabled()) {
      // Один DSR-запрос на кадр, дальше якорь ведёт локальная скролл-математика.
      // В question-режиме не спрашиваем (см. dsrEnabled). Таймаут сбрасывает
      // dsrPending, чтобы неотвечающий терминал откатился на относительные ходы.
      this.dsrPending = true;
      this.dsrQueryRow = idx;
      this.output.write("\x1b[6n");
      if (this.dsrTimer) clearTimeout(this.dsrTimer);
      this.dsrTimer = setTimeout(() => {
        this.dsrPending = false;
        this.dsrTimer = null;
      }, 150);
    }
  }

  /** Последовательность возврата на верх кадра (или "\r" без якоря). */
  private returnToFrameTop(): string {
    if (this.frameTopAbs !== null) return `\x1b[${this.frameTopAbs};1H`;
    if (this.prevCursorRow > 0) return `\x1b[${this.prevCursorRow}A`;
    return "";
  }

  /** Move the cursor to the end of the buffer's last visual row so the
   *  submitted text stays on screen (commit), without erasing the frame.
   *  Uses the absolute anchor when known — relative moves land short once
   *  a tall frame has scrolled the terminal. */
  commitSeq(): string {
    const full = this.layout();
    const visible = this.visibleLayout();
    const lastLen = charLen(stripAnsi(visible[visible.length - 1].text));
    if (this.frameTopAbs !== null) {
      return `\x1b[${this.frameTopAbs + visible.length - 1};${lastLen + 1}H`;
    }
    // Строка курсора ищется по ПОЛНОМУ layout: обрезанный кадр (видимая
    // часть) курсора может не содержать, и индекс по нему вёл бы в никуда
    // (аудит §8.12). Обрезанный layout — только для отрисовки.
    const idxFull = layoutIndexFor(full, this.buf.row, this.buf.col);
    const offset = full.length - visible.length;
    const idx = Math.max(0, Math.min(idxFull - offset, visible.length - 1));
    const rowsDown = visible.length - 1 - idx;
    const out: string[] = [];
    if (rowsDown > 0) out.push(`\x1b[${rowsDown}B`);
    out.push("\r");
    if (lastLen > 0) out.push(`\x1b[${lastLen}C`);
    return out.join("");
  }

  /** Очищает кадр промпта (агент забирает терминал). */
  eraseSeq(): string {
    return `${this.returnToFrameTop()}\r\x1b[J`;
  }

  /** Печать блока строк над кадром без стирания ввода. */
  printAboveSeq(text: string): string {
    const body = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").join("\r\n");
    return `${this.eraseSeq()}${body}\r\n`;
  }
}
