// Цвета терминала (picocolors): вкл только в TTY и без CI/NO_COLOR.
import { createColors } from "picocolors";

const isTty = (): boolean => process.stdout.isTTY === true;

const enabled: boolean = isTty() && !process.env.CI && !process.env.NO_COLOR;

/** Палитра picocolors (no-op вне TTY / при CI / NO_COLOR). */
export const pc = createColors(enabled);
