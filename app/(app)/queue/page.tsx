import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { ClassBadge, Flash, FormBtn, when } from "@/components/ui";
import { actCancelBooking, actClose, actContacted, actKeep, actSendToDesigner } from "../actions";

export const metadata = { title: "Review queue · Aangan Studio" };

export default async function Queue({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { msg, err } = await searchParams;
  const { sb } = await requireStaff();

  const { data: leads } = await sb
    .from("leads")
    .select("*, calls(caller_phone, started_at, transcript, duration_sec, after_hours, repeat_caller)")
    .eq("status", "in_review")
    .order("created_at", { ascending: false })
    .limit(100);
  const ids = (leads ?? []).map((l) => l.id as string);
  const { data: held } = ids.length ? await sb.from("bookings").select("*").in("lead_id", ids).in("status", ["provisional", "confirmed"]) : { data: [] };
  const { data: designers } = await sb.from("designers").select("id, name, specialisation").eq("active", true).order("name");

  return (
    <>
      <h1>Front desk review queue</h1>
      <p className="muted">Calls that need a human decision: borderline, not qualified, price discussed, complaints, or the AI could not finish. Nobody here has been turned away; each one was told the team would be in touch.</p>
      <Flash msg={msg} err={err} />
      {!leads?.length && <p className="card muted">Nothing waiting. 🎉</p>}
      {(leads ?? []).map((l) => {
        const call = l.calls as { caller_phone: string; started_at: string; transcript: string; after_hours: boolean; repeat_caller: boolean } | null;
        const b = (held ?? []).find((x) => x.lead_id === l.id);
        const summary = [l.project_type !== "unknown" ? l.project_type : null, l.location, l.bhk_or_rooms, l.carpet_area_sqft ? `${l.carpet_area_sqft} sq ft` : null, l.scope, l.timeline ? `timeline: ${l.timeline}` : null].filter(Boolean).join(" · ");
        const ret = "/queue";
        return (
          <article className="card" key={l.id}>
            <header>
              <strong>{l.caller_name ?? "Unnamed caller"}</strong>
              <ClassBadge lead={l} />
              {l.price_mentioned_in_call && <span className="badge warn">price discussed</span>}
              {call?.repeat_caller && <span className="badge info">repeat caller</span>}
              {call?.after_hours && <span className="badge">after hours</span>}
              <span className="muted small">{call?.caller_phone} · {when(call?.started_at)}</span>
            </header>
            <p style={{ margin: "8px 0 0" }}>{summary || <span className="muted">No details captured</span>}</p>
            <p className="reason"><b>Why it is here:</b> {l.review_reason ?? l.classification_reason ?? "flagged for review"}</p>
            {b && (
              <div className="held">
                <span>📅 Consult {b.status === "provisional" ? "on hold" : "booked"}: <b>{when(b.slot_start)}</b></span>
                {b.status === "provisional" && (
                  <>
                    <FormBtn action={actKeep} fields={{ booking: b.id, return: ret }}>Keep</FormBtn>
                    <FormBtn action={actCancelBooking} fields={{ booking: b.id, return: ret }} className="danger">Cancel &amp; message caller</FormBtn>
                  </>
                )}
              </div>
            )}
            <details>
              <summary>Handoff note &amp; transcript</summary>
              <p>{l.handoff_note ?? "No note."}</p>
              {l.missing_info?.length ? <p className="muted small">Still to ask: {l.missing_info.join(", ")}</p> : null}
              <pre className="transcript">{call?.transcript || "No transcript"}</pre>
            </details>
            <div className="actions">
              <form action={actSendToDesigner}>
                <input type="hidden" name="lead" value={l.id} />
                <input type="hidden" name="return" value={ret} />
                <select name="designer" required defaultValue="">
                  <option value="" disabled>Send to designer…</option>
                  {(designers ?? []).map((d) => <option key={d.id} value={d.id}>{d.name} ({d.specialisation})</option>)}
                </select>
                <button className="primary">Send</button>
              </form>
              <FormBtn action={actContacted} fields={{ lead: l.id, return: ret }}>Mark contacted</FormBtn>
              <FormBtn action={actClose} fields={{ lead: l.id, return: ret }}>Close</FormBtn>
              <Link className="btn" href={`/leads/${l.id}`}>Open</Link>
            </div>
          </article>
        );
      })}
    </>
  );
}
