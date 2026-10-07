import { esc, canUseUrlButton, type Button } from "@/lib/telegram";
import { fmtWhen, fmtTime, minutesUntil } from "@/lib/time";

/** Everything a template needs, already loaded. Templates are pure so they can be snapshot-tested. */
export interface Ctx {
  now: Date;
  baseUrl: string;
  lead: {
    id: string;
    caller_name: string | null;
    project_type: string;
    location: string | null;
    carpet_area_sqft: number | null;
    bhk_or_rooms: string | null;
    budget_range: string | null;
    timeline: string | null;
    possession_status: string;
    classification: string | null;
    handoff_note: string | null;
    missing_info: string[];
    review_reason: string | null;
    sla_due_at: string | null;
    callback_due_at: string | null;
  };
  callerPhone: string;
  designerName?: string | null;
  booking?: { slot_start: string } | null;
  project_value_range?: { min: number; max: number };
}

export interface Rendered {
  text: string;
  buttons?: Button[][];
}

const name = (c: Ctx) => c.lead.caller_name ?? "Unnamed caller";
const typeLabel = (c: Ctx) => (c.lead.project_type === "home" ? "Home" : c.lead.project_type === "office" ? "Office" : "Project");
const where = (c: Ctx) => c.lead.location ?? "location not given";
const leadUrl = (c: Ctx) => `${c.baseUrl}/leads/${c.lead.id}`;
const due = (c: Ctx) => new Date(c.lead.sla_due_at ?? c.lead.callback_due_at ?? c.now);

/** Link button on public https URLs, otherwise a plain link line (localhost URLs make Telegram reject the message). */
function linkRow(c: Ctx): { button?: Button; line: string } {
  const url = leadUrl(c);
  return canUseUrlButton(url) ? { button: { text: "Open lead", url }, line: "" } : { line: `\n${esc(url)}` };
}

export function newEnquiry(c: Ctx): Rendered {
  const cls = c.lead.classification ? c.lead.classification.replace("_", " ") : "needs review";
  const who = c.designerName ?? "needs review";
  const l = linkRow(c);
  return {
    text: `📞 <b>New enquiry</b> — ${fmtTime(c.now)} · ${typeLabel(c)}, ${esc(where(c))} · ${esc(cls)} → ${esc(who)} · Due: ${fmtWhen(due(c), c.now)}${l.line}`,
    buttons: l.button ? [[l.button]] : undefined,
  };
}

export function leadAssigned(c: Ctx): Rendered {
  const mins = minutesUntil(due(c), c.now);
  const area = [c.lead.carpet_area_sqft ? `${c.lead.carpet_area_sqft} sq ft` : null, c.lead.bhk_or_rooms].filter(Boolean).join(" / ") || "area not shared";
  const booked = c.booking
    ? `Booked call: ${fmtWhen(new Date(c.booking.slot_start), c.now)}`
    : `Callback promised by: ${fmtWhen(new Date(c.lead.callback_due_at ?? due(c)), c.now)}`;
  const v = c.project_value_range;
  const l = linkRow(c);
  // Booked lead: the call happens at the booked time; the SLA only governs how fast the designer must ACCEPT.
  const headline = c.booking
    ? `🔴 <b>NEW LEAD — consult booked ${fmtWhen(new Date(c.booking.slot_start), c.now)} (in ${minutesUntil(new Date(c.booking.slot_start), c.now)} min) · accept by ${fmtWhen(due(c), c.now)}</b>`
    : `🔴 <b>NEW LEAD — call by ${fmtWhen(due(c), c.now)} (in ${mins} min)</b>`;
  const accept: Button = { text: "✅ Accept", callback_data: `a:${c.lead.id}` };
  const reassign: Button = { text: "↪ Reassign", callback_data: `r:${c.lead.id}` };
  return {
    text: [
      headline,
      `Calls within 1 hr convert 4× better.${v ? ` Indicative project value: ₹${v.min}–${v.max}L (indicative only).` : ""}`,
      "",
      `🏠 <b>New qualified lead — ${typeLabel(c)}, ${esc(where(c))}</b>`,
      `${esc(name(c))} · ${esc(area)} · Budget: ${esc(c.lead.budget_range ?? "not shared")}`,
      `Timeline: ${esc(c.lead.timeline ?? "not shared")} · Possession: ${esc(c.lead.possession_status.replace("_", " "))}`,
      "",
      esc(c.lead.handoff_note ?? ""),
      "",
      `Still to ask: ${esc(c.lead.missing_info.length ? c.lead.missing_info.join(", ") : "nothing")}`,
      booked,
      `Phone: ${esc(c.callerPhone)}${l.line}`,
    ].join("\n"),
    buttons: [[accept, reassign], ...(l.button ? [[l.button]] : [])],
  };
}

export function reminder(c: Ctx): Rendered {
  return { text: `⏰ <b>Reminder:</b> ${esc(name(c))} is waiting. Due in ${minutesUntil(due(c), c.now)} min.`, buttons: [[{ text: "✅ Accept", callback_data: `a:${c.lead.id}` }]] };
}

export function slaBreach(c: Ctx): Rendered {
  return {
    text: `🚨 <b>Overdue:</b> ${esc(name(c))}, ${esc(c.designerName ?? "the designer")} hasn't accepted. Reassign?`,
    buttons: [[{ text: "↪ Reassign", callback_data: `r:${c.lead.id}` }]],
  };
}

export function callReminder(c: Ctx): Rendered {
  const l = linkRow(c);
  const when = c.booking ? fmtTime(new Date(c.booking.slot_start)) : "soon";
  return { text: `📅 Call with ${esc(name(c))} at ${when}${l.line}`, buttons: l.button ? [[l.button]] : undefined };
}

export function needsReview(c: Ctx): Rendered {
  const l = linkRow(c);
  return { text: `⚠️ <b>Needs review:</b> ${esc(c.lead.review_reason ?? "flagged for review")}${l.line}`, buttons: l.button ? [[l.button]] : undefined };
}

export function escalation(c: Ctx): Rendered {
  const l = linkRow(c);
  return {
    text: [
      `🚨 <b>Existing client needs a senior callback</b>`,
      `${esc(name(c))} · ${esc(c.callerPhone)} · ${esc(where(c))}`,
      esc(c.lead.handoff_note ?? ""),
      l.line.trim(),
    ].filter(Boolean).join("\n"),
    buttons: l.button ? [[l.button]] : undefined,
  };
}

export interface DigestStats {
  calls: number;
  qualified: number;
  booked: number;
  pendingReview: number;
}

export function digest(s: DigestStats): Rendered {
  return {
    text: `🌅 <b>Overnight digest</b>\nCalls received: ${s.calls}\nQualified: ${s.qualified}\nConsults booked: ${s.booked}\nPending review: ${s.pendingReview}`,
  };
}

// ── caller SMS (plain text, never any price) ──
export function callerSms(c: Ctx): string {
  const hello = c.lead.caller_name ? `Hi ${c.lead.caller_name}, ` : "";
  if (c.booking) {
    return `${hello}thanks for calling Aangan Studio. Your consultation call with our designer is booked for ${fmtWhen(new Date(c.booking.slot_start), c.now)}. We'll call you then.`;
  }
  const by = fmtWhen(new Date(c.lead.callback_due_at ?? c.now), c.now);
  return `${hello}thanks for calling Aangan Studio. We have your enquiry and a member of our team will call you by ${by}.`;
}

/** Front desk cancelled a held consult (borderline / not qualified). Polite, no reason given, no price, no promise. */
export function callerCancelSms(c: Ctx): string {
  const hello = c.lead.caller_name ? `Hi ${c.lead.caller_name}, ` : "";
  return `${hello}thank you for your interest in Aangan Studio. After reviewing your enquiry we are unable to go ahead with the consultation we had pencilled in. Thank you for calling, and please do get in touch if your plans change.`;
}
