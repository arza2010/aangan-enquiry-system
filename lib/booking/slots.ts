import { addMinutes, isWorkingTime, type Hours } from "@/lib/time";

export interface SlotRules {
  hours: Hours;
  workingDays: number[];
  minLeadMinutes: number; // earliest bookable, from now (default 30)
  horizonHours: number; // latest bookable, from now (default 48)
}

/**
 * Offer up to 3 start times: the earliest first (earlier consults convert better), then ones at least 2 hours apart so
 * the caller has a real choice. Working hours / lead time / horizon are re-checked here even though Cal.com
 * enforces its own availability, so a misconfigured Cal.com schedule can never make us offer 3am.
 */
export function pickSlots(starts: string[], now: Date, r: SlotRules, max = 3): string[] {
  const min = addMinutes(now, r.minLeadMinutes).getTime();
  const maxT = addMinutes(now, r.horizonHours * 60).getTime();
  const ok = [...new Set(starts)]
    .sort()
    .filter((s) => {
      const t = new Date(s);
      return t.getTime() >= min && t.getTime() <= maxT && isWorkingTime(t, r.hours, r.workingDays);
    });
  const picks: string[] = [];
  for (const s of ok) {
    if (picks.length === 0 || new Date(s).getTime() - new Date(picks[picks.length - 1]).getTime() >= 120 * 60_000) picks.push(s);
    if (picks.length === max) break;
  }
  for (const s of ok) if (picks.length < max && !picks.includes(s)) picks.push(s); // sparse calendar: fill with whatever is left
  return picks.sort();
}
