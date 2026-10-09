/**
 * "4 minutes ago", "yesterday", "3 weeks ago" — the relative times of the
 * history panel and the start page (#213), one wording. `now` is injectable,
 * so the wording is unit-tested without a clock.
 */
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const STEPS: [number, Intl.RelativeTimeFormatUnit][] = [
  [60 * 24 * 365, "year"],
  [60 * 24 * 30, "month"],
  [60 * 24 * 7, "week"],
  [60 * 24, "day"],
  [60, "hour"],
  [1, "minute"],
];

/** an ISO timestamp relative to `now`; an unparsable one is returned as is */
export function timeAgo(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const minutes = Math.round((then - now) / 60_000);
  for (const [size, unit] of STEPS) {
    if (Math.abs(minutes) >= size) return rtf.format(Math.trunc(minutes / size), unit);
  }
  return rtf.format(minutes, "minute");
}

/** the absolute time for a tooltip — the reader's locale and time zone */
export function absoluteTime(iso: string): string {
  const then = Date.parse(iso);
  return Number.isNaN(then)
    ? iso
    : new Date(then).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
