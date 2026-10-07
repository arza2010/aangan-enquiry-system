import { istDate, istParts } from "./time";

export interface Period { from: Date; to: Date; days: number; label: string } // [from, to) in IST days

const ymd = (s: string | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split("-").map(Number) as [number, number, number] : null);
const fmtDay = (d: Date) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }).format(d);

/**
 * Default: this month so far vs the whole of last month. With ?from=&to= (inclusive IST dates): that range vs the
 * equally long range just before it.
 */
export function periodsFor(now: Date, from?: string, to?: string): { current: Period; previous: Period } {
  const f = ymd(from);
  const t = ymd(to);
  const today = istParts(now);
  let cFrom: Date, cTo: Date, pFrom: Date, pTo: Date;
  if (f && t) {
    cFrom = istDate(f[0], f[1] - 1, f[2], 0);
    cTo = istDate(t[0], t[1] - 1, t[2] + 1, 0);
    if (cTo <= cFrom) throw new Error("'to' must be on or after 'from'");
    pTo = cFrom;
    pFrom = new Date(cFrom.getTime() - (cTo.getTime() - cFrom.getTime()));
  } else {
    cFrom = istDate(today.y, today.m, 1, 0);
    cTo = istDate(today.y, today.m, today.d + 1, 0);
    pFrom = istDate(today.y, today.m - 1, 1, 0);
    pTo = cFrom;
  }
  const days = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);
  const label = (a: Date, b: Date) => `${fmtDay(a)} – ${fmtDay(new Date(b.getTime() - 1))}`;
  return {
    current: { from: cFrom, to: cTo, days: days(cFrom, cTo), label: label(cFrom, cTo) },
    previous: { from: pFrom, to: pTo, days: days(pFrom, pTo), label: label(pFrom, pTo) },
  };
}
