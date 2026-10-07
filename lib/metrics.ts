/** Nikhil's dashboard numbers, computed from raw rows so they can be unit-tested. No database access in here. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

export interface MetricRows {
  calls: Row[];
  leads: Row[];
  bookings: Row[];
  notifications: Row[];
  costs: Row[];
  settings: Record<string, unknown>;
  days: number; // length of the period, for prorating monthly hosting
}

const mins = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 60_000;
const pct = (n: number, d: number) => (d === 0 ? null : (100 * n) / d);

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const HANDED_OFF = ["sent_to_designer", "accepted", "contacted", "won", "lost"];

export function computeMetrics(r: MetricRows) {
  const callById = new Map(r.calls.map((c) => [c.id, c]));
  const enquiries = r.leads.filter((l) => (l.call_type ?? "new_enquiry") === "new_enquiry");
  const qualified = enquiries.filter((l) => l.classification === "qualified");
  const live = r.bookings.filter((b) => !["cancelled"].includes(b.status));

  // Leading metrics: speed
  const firstAlert = (leadId: string, type: string) =>
    r.notifications.filter((n) => n.lead_id === leadId && n.type === type && n.sent_at).sort((a, b) => a.sent_at.localeCompare(b.sent_at))[0];
  const callEnd = (c: Row) => c.ended_at ?? c.started_at;
  const alerted = r.leads.map((l) => {
    const c = callById.get(l.call_id);
    const n = firstAlert(l.id, "new_enquiry");
    return c && n ? mins(callEnd(c), n.sent_at) : null;
  });
  const alertedWithin5 = alerted.filter((x) => x !== null && x <= 5).length;

  const acceptFromCall: number[] = [];
  const acceptFromAlert: number[] = [];
  for (const l of r.leads) {
    if (!l.accepted_at) continue;
    const c = callById.get(l.call_id);
    if (c) acceptFromCall.push(mins(callEnd(c), l.accepted_at));
    const a = firstAlert(l.id, "lead_assigned");
    if (a) acceptFromAlert.push(mins(a.sent_at, l.accepted_at));
  }

  const callbackSet = r.leads.filter((l) => l.first_response_at && l.callback_due_at);
  const onTime = callbackSet.filter((l) => new Date(l.first_response_at) <= new Date(l.callback_due_at)).length;

  // Consults
  const qualifiedWithBooking = qualified.filter((l) => live.some((b) => b.lead_id === l.id)).length;

  // Conversion
  const won = r.leads.filter((l) => l.status === "won").length;
  const lost = r.leads.filter((l) => l.status === "lost").length;
  const baseline = typeof r.settings.baseline_conversion_rate === "number" ? (r.settings.baseline_conversion_rate as number) : null;

  // Cost
  const byService: Record<string, number> = { vaani: 0, llm: 0, sms: 0, telegram: 0 };
  for (const c of r.costs) byService[c.service] = (byService[c.service] ?? 0) + Number(c.cost_inr);
  const monthly = Number(r.settings.monthly_hosting_inr ?? 0);
  const hosting = (monthly * r.days) / 30;
  const variable = Object.values(byService).reduce((a, b) => a + b, 0);
  const total = variable + hosting;

  const range = (r.settings.project_value_range_lakh as { min: number; max: number } | undefined) ?? { min: 8, max: 14 };
  const classes = { qualified: 0, borderline: 0, not_qualified: 0, other: 0, unclassified: 0 };
  for (const l of r.leads) {
    if ((l.call_type ?? "new_enquiry") !== "new_enquiry") classes.other++;
    else if (l.classification && l.classification in classes) classes[l.classification as keyof typeof classes]++;
    else classes.unclassified++;
  }

  return {
    callsReceived: r.calls.length,
    pctAlertedWithin5Min: pct(alertedWithin5, alerted.filter((x) => x !== null).length),
    afterHoursCaptured: r.calls.filter((c) => c.after_hours).length,
    repeatCallers: r.calls.filter((c) => c.repeat_caller).length,
    classes,
    qualified: qualified.length,
    qualifiedHandedOff: qualified.filter((l) => HANDED_OFF.includes(l.status)).length,
    medianMinToAccept: median(acceptFromCall),
    medianMinAlertToAccept: median(acceptFromAlert),
    pctCallbacksOnTime: pct(onTime, callbackSet.length),
    callbacksMeasured: callbackSet.length,
    consultsBookedPct: pct(qualifiedWithBooking, qualified.length),
    consultsBooked: live.length,
    consultsCompleted: r.bookings.filter((b) => b.status === "completed").length,
    consultsNoShow: r.bookings.filter((b) => b.status === "no_show").length,
    won, lost,
    conversionPct: pct(won, qualified.length),
    baselineConversionPct: baseline === null ? null : baseline > 1 ? baseline : baseline * 100,
    cost: {
      total, byService, hosting,
      perCall: r.calls.length ? total / r.calls.length : null,
      perQualified: qualified.length ? total / qualified.length : null,
    },
    pipeline: { minLakh: qualified.length * range.min, maxLakh: qualified.length * range.max, range },
  };
}

export type Metrics = ReturnType<typeof computeMetrics>;
