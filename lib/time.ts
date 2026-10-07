/**
 * Asia/Kolkata time helpers. India has no DST (fixed UTC+05:30), so we shift by a constant and use UTC getters.
 * Everything here is pure and takes explicit `Date`s, so it is unit-testable.
 */
const IST_MS = 5.5 * 3600_000;

export interface Hours {
  start: string;
  end: string;
}

export const hhmmToMin = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

export function istParts(d: Date) {
  const t = new Date(d.getTime() + IST_MS);
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth(),
    d: t.getUTCDate(),
    minutes: t.getUTCHours() * 60 + t.getUTCMinutes(),
    isoWeekday: t.getUTCDay() === 0 ? 7 : t.getUTCDay(),
  };
}

/** Build a Date from an IST wall-clock time. */
export function istDate(y: number, m: number, d: number, minutes: number): Date {
  return new Date(Date.UTC(y, m, d, 0, minutes) - IST_MS);
}

export const addMinutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);

export function isWorkingTime(d: Date, hours: Hours, workingDays: number[]): boolean {
  const p = istParts(d);
  return workingDays.includes(p.isoWeekday) && p.minutes >= hhmmToMin(hours.start) && p.minutes < hhmmToMin(hours.end);
}

/** First moment strictly after `d` that is `hhmm` IST on a day in `days` (all days if omitted). */
export function nextOccurrence(d: Date, hhmm: string, days?: number[]): Date {
  const p = istParts(d);
  for (let i = 0; i < 8; i++) {
    const cand = istDate(p.y, p.m, p.d + i, hhmmToMin(hhmm));
    const wd = istParts(cand).isoWeekday;
    if (cand.getTime() > d.getTime() && (!days || days.includes(wd))) return cand;
  }
  throw new Error("no working day found in the next week: check the working_days setting");
}

/** Quiet hours may cross midnight (21:00-08:00). */
export function inQuietHours(d: Date, q: Hours): boolean {
  const mins = istParts(d).minutes;
  const s = hhmmToMin(q.start);
  const e = hhmmToMin(q.end);
  return s <= e ? mins >= s && mins < e : mins >= s || mins < e;
}

/** If `d` is inside quiet hours, push to the moment they end. */
export function afterQuietHours(d: Date, q: Hours): Date {
  return inQuietHours(d, q) ? nextOccurrence(d, q.end) : d;
}

export interface TimingSettings {
  hours: Hours;
  workingDays: number[];
  slaMinutes: number;
  afterHoursDeadline: string;
  callbackMinutes: number;
  afterHoursCallback: string;
}

/**
 * When must a designer Accept? In hours: call end + 30 min (if that overruns closing time, next working
 * morning at the after-hours deadline). Out of hours: next working morning at the deadline (10:30).
 */
export function computeSlaDue(callTime: Date, t: TimingSettings): Date {
  if (isWorkingTime(callTime, t.hours, t.workingDays)) {
    const due = addMinutes(callTime, t.slaMinutes);
    if (isWorkingTime(due, t.hours, t.workingDays)) return due;
  }
  return nextOccurrence(callTime, t.afterHoursDeadline, t.workingDays);
}

/** The time promised to a caller who did not book a slot. */
export function computeCallbackDue(callTime: Date, t: TimingSettings): Date {
  if (isWorkingTime(callTime, t.hours, t.workingDays)) {
    const due = addMinutes(callTime, t.callbackMinutes);
    if (isWorkingTime(due, t.hours, t.workingDays)) return due;
  }
  return nextOccurrence(callTime, t.afterHoursCallback, t.workingDays);
}

const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", ...opts }).format(d);
export const fmtTime = (d: Date) => fmt(d, { hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s?([ap])m/i, (_, x) => ` ${x.toLowerCase()}m`);
export const fmtDay = (d: Date) => fmt(d, { weekday: "short", day: "numeric", month: "short" });
/** "Wed 16 Sep, 4:30 pm", or just the time if it is today (IST). */
export function fmtWhen(d: Date, now = new Date()): string {
  const a = istParts(d);
  const b = istParts(now);
  const sameDay = a.y === b.y && a.m === b.m && a.d === b.d;
  return sameDay ? fmtTime(d) : `${fmtDay(d)}, ${fmtTime(d)}`;
}
export const minutesUntil = (d: Date, now: Date) => Math.max(0, Math.round((d.getTime() - now.getTime()) / 60_000));
