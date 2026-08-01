import { createColors } from "picocolors";

const isTty = (): boolean => process.stdout.isTTY === true;

const enabled: boolean = isTty() && !process.env.CI && !process.env.NO_COLOR;

export const pc = createColors(enabled);
