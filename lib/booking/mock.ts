import type { BookingProvider, ProviderBooking } from "./types";
import { istDate, istParts, isWorkingTime, type Hours } from "@/lib/time";

/** In-memory Cal.com stand-in for tests and the simulator: 30-min grid inside working hours, one consult at a time. */
export function mockProvider(opts: { now: () => Date; hours?: Hours; days?: number[] }): BookingProvider & { all: ProviderBooking[] } {
  const hours = opts.hours ?? { start: "10:00", end: "19:00" };
  const days = opts.days ?? [1, 2, 3, 4, 5, 6];
  const all: ProviderBooking[] = [];
  let n = 0;
  const taken = (iso: string) => all.some((b) => b.start === iso && b.status !== "cancelled");
  return {
    name: "mock",
    all,
    async getSlots(fromIso, toIso) {
      const from = new Date(fromIso).getTime();
      const to = new Date(toIso).getTime();
      const out: string[] = [];
      const p = istParts(new Date(from));
      for (let d = 0; d <= 4; d++) {
        for (let m = 10 * 60; m < 19 * 60; m += 30) {
          const t = istDate(p.y, p.m, p.d + d, m);
          if (t.getTime() >= from && t.getTime() <= to && isWorkingTime(t, hours, days) && !taken(t.toISOString())) out.push(t.toISOString());
        }
      }
      return out;
    },
    async book({ start, name, phone }) {
      const iso = new Date(start).toISOString();
      if (taken(iso)) throw new Error("Cal.com POST /bookings -> 400: slot no longer available");
      const b: ProviderBooking = {
        uid: `mock-${++n}`, start: iso, end: new Date(new Date(iso).getTime() + 20 * 60_000).toISOString(),
        status: "accepted", createdAt: opts.now().toISOString(), attendeeName: name, attendeePhone: phone,
      };
      all.push(b);
      return { uid: b.uid, start: b.start, end: b.end };
    },
    async cancel(uid) {
      const b = all.find((x) => x.uid === uid);
      if (b) b.status = "cancelled";
    },
    async get(uid) {
      return all.find((x) => x.uid === uid) ?? null;
    },
    async listCreatedBetween(fromIso, toIso) {
      return all.filter((b) => b.createdAt >= fromIso && b.createdAt <= toIso);
    },
  };
}
