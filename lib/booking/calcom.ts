import type { BookingProvider, ProviderBooking } from "./types";

const BASE = "https://api.cal.com/v2";
// Cal.com versions each endpoint family separately; sending the wrong one silently gives an older behaviour.
const V = { slots: "2024-09-04", bookings: "2026-02-25", bookingsList: "2026-05-01" };

export interface CalcomConfig {
  apiKey: string;
  eventTypeId: number;
  /**
   * Cal.com insists on an attendee email AND checks that its domain can receive mail (example.com is rejected).
   * Callers on the phone have none, so we plus-address a real mailbox the studio owns: frontdesk@x.com becomes
   * frontdesk+caller919876543210@x.com (Gmail and Google Workspace deliver those to frontdesk@x.com).
   */
  attendeeEmail: string;
  f?: typeof fetch;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function callerEmail(mailbox: string, phone: string): string {
  const [local, domain] = mailbox.split("@");
  if (!local || !domain) throw new Error("CALCOM_ATTENDEE_EMAIL must be a full email address");
  return `${local.split("+")[0]}+caller${phone.replace(/\D/g, "")}@${domain}`;
}

export function calcomProvider(cfg: CalcomConfig): BookingProvider {
  const f = cfg.f ?? fetch;
  async function api(method: string, path: string, version: string, body?: unknown): Promise<Json> {
    const res = await f(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.apiKey}`, "cal-api-version": version, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Cal.com ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? (JSON.parse(text) as Json) : {};
  }

  const toBooking = (b: Json): ProviderBooking => ({
    uid: b.uid,
    start: new Date(b.start).toISOString(),
    end: new Date(b.end ?? b.start).toISOString(),
    status: String(b.status ?? "accepted").toLowerCase(),
    createdAt: new Date(b.createdAt ?? Date.now()).toISOString(),
    attendeeName: b.attendees?.[0]?.name,
    attendeePhone: b.attendees?.[0]?.phoneNumber,
  });

  return {
    name: "calcom",
    async getSlots(fromIso, toIso) {
      const q = new URLSearchParams({ eventTypeId: String(cfg.eventTypeId), start: fromIso, end: toIso, timeZone: "Asia/Kolkata" });
      const r = await api("GET", `/slots?${q}`, V.slots);
      // data: { "2026-09-16": [{ start: "2026-09-16T10:00:00.000+05:30" }, ...], ... }
      return Object.values((r.data ?? {}) as Record<string, { start: string }[]>)
        .flat()
        .map((s) => new Date(s.start).toISOString())
        .sort();
    },
    async book({ start, name, phone, callRef }) {
      const r = await api("POST", "/bookings", V.bookings, {
        start,
        eventTypeId: cfg.eventTypeId,
        attendee: {
          name,
          email: callerEmail(cfg.attendeeEmail, phone),
          timeZone: "Asia/Kolkata",
          phoneNumber: phone,
          language: "en",
        },
        metadata: { source: "aangan-voice-agent", call: callRef.slice(0, 500) },
      });
      const b = toBooking(r.data);
      return { uid: b.uid, start: b.start, end: b.end };
    },
    async cancel(uid, reason) {
      await api("POST", `/bookings/${uid}/cancel`, V.bookings, { cancellationReason: reason });
    },
    async get(uid) {
      try {
        return toBooking((await api("GET", `/bookings/${uid}`, V.bookings)).data);
      } catch (e) {
        if (String(e).includes("404")) return null;
        throw e;
      }
    },
    async listCreatedBetween(fromIso, toIso) {
      const q = new URLSearchParams({
        eventTypeId: String(cfg.eventTypeId), afterCreatedAt: fromIso, beforeCreatedAt: toIso, sortCreated: "asc", limit: "20",
      });
      const r = await api("GET", `/bookings?${q}`, V.bookingsList);
      return ((r.data ?? []) as Json[]).map(toBooking);
    },
  };
}

/** Configured only when both values exist; otherwise null and the pipeline carries on without booking support. */
export function calcomFromEnv(f?: typeof fetch): BookingProvider | null {
  const apiKey = process.env.CALCOM_API_KEY;
  const id = Number(process.env.CALCOM_EVENT_TYPE_ID);
  const attendeeEmail = process.env.CALCOM_ATTENDEE_EMAIL;
  if (!apiKey || !id) return null;
  if (!attendeeEmail) {
    console.warn("CALCOM_ATTENDEE_EMAIL is not set: Cal.com rejects bookings without a real attendee email, so booking is disabled");
    return null;
  }
  return calcomProvider({ apiKey, eventTypeId: id, attendeeEmail, f });
}
