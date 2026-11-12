// Client timezone helper for the composer (B18b, rule ≤300 lines/file).
// Kept apart from `composer.ts` so the UI module stays under the size ceiling.

/** Client timezone for the server: IANA zone + `±HH:MM` offset. */
export function clientTimeZone(): { timeZone: string; utcOffset: string } {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  const mins = -new Date().getTimezoneOffset();
  const sign = mins >= 0 ? "+" : "-";
  const abs = Math.abs(mins);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { timeZone, utcOffset: `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}` };
}
