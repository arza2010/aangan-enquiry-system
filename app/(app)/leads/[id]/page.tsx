import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { ClassBadge, Flash, FormBtn, when } from "@/components/ui";
import { actClose, actConsultDone, actConsultNoShow, actContacted, actLost, actSendToDesigner, actWon } from "../../actions";

export default async function LeadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const { sb } = await requireStaff();
  const { data: lead } = await sb.from("leads").select("*, calls(caller_phone, started_at, transcript, duration_sec, after_hours, repeat_caller, recording_url)").eq("id", id).maybeSingle();
  if (!lead) notFound();
  const call = lead.calls as { caller_phone: string; started_at: string; transcript: string; duration_sec: number | null; after_hours: boolean; repeat_caller: boolean; recording_url: string | null } | null;
  const { data: designer } = lead.assigned_designer_id ? await sb.from("designers").select("name").eq("id", lead.assigned_designer_id).maybeSingle() : { data: null };
  const { data: bookings } = await sb.from("bookings").select("*").eq("lead_id", id).order("slot_start");
  const { data: notes } = await sb.from("notifications").select("type, recipient_type, scheduled_for, sent_at, acted_at, cancelled_at, error").eq("lead_id", id).order("scheduled_for");
  const { data: designers } = await sb.from("designers").select("id, name, specialisation").eq("active", true).order("name");
  const ret = `/leads/${id}`;
  const rows: [string, React.ReactNode][] = [
    ["Phone", call?.caller_phone], ["Called", `${when(call?.started_at)}${call?.duration_sec ? ` · ${Math.round(call.duration_sec / 60)} min` : ""}`],
    ["Project", [lead.project_type, lead.location].filter((x) => x && x !== "unknown").join(" · ") || "—"], ["Size", [lead.bhk_or_rooms, lead.carpet_area_sqft && `${lead.carpet_area_sqft} sq ft`].filter(Boolean).join(" · ") || "—"],
    ["Scope", lead.scope ?? "—"], ["Budget (as stated)", lead.budget_range ?? "not shared"], ["Timeline", lead.timeline ?? "—"], ["Possession", lead.possession_status],
    ["Heard via", lead.source ?? "—"], ["Assigned to", designer?.name ?? "—"], ["Accept by", when(lead.sla_due_at)], ["Accepted", when(lead.accepted_at)],
    ["Callback promised by", when(lead.callback_due_at)], ["First contact", when(lead.first_response_at)],
    ["HubSpot", `${lead.hubspot_sync_status}${lead.hubspot_deal_id ? " · deal " + lead.hubspot_deal_id : ""}${lead.hubspot_sync_error ? " · " + lead.hubspot_sync_error : ""}`],
  ];
  return (
    <>
      <p><Link href="/queue">← Review queue</Link></p>
      <h1>{lead.caller_name ?? "Unnamed caller"} <ClassBadge lead={lead} /> <span className="badge">{lead.status.replace("_", " ")}</span></h1>
      <Flash msg={msg} err={err} />
      <p className="reason"><b>Classification:</b> {lead.classification_reason ?? "—"}{lead.review_reason ? <><br /><b>Review:</b> {lead.review_reason}</> : null}</p>
      <div className="card">
        <table><tbody>{rows.map(([k, v]) => <tr key={k}><th style={{ width: 190 }}>{k}</th><td>{v}</td></tr>)}</tbody></table>
      </div>
      <h2>Handoff note</h2>
      <div className="card"><p style={{ margin: 0 }}>{lead.handoff_note ?? "No note."}</p>{lead.missing_info?.length ? <p className="muted small">Still to ask: {lead.missing_info.join(", ")}</p> : null}</div>

      <h2>Consults</h2>
      {!bookings?.length && <p className="muted">No consult booked.</p>}
      {(bookings ?? []).map((b) => (
        <div className="card" key={b.id}>
          <b>{when(b.slot_start)}</b> <span className="badge">{b.status}</span>
          {["provisional", "confirmed"].includes(b.status) && new Date(b.slot_start) < new Date() && (
            <span className="actions" style={{ display: "inline-flex", marginLeft: 12 }}>
              <FormBtn action={actConsultDone} fields={{ booking: b.id, return: ret }}>Completed</FormBtn>
              <FormBtn action={actConsultNoShow} fields={{ booking: b.id, return: ret }}>No-show</FormBtn>
            </span>
          )}
        </div>
      ))}

      <h2>Outcome</h2>
      <div className="actions">
        <FormBtn action={actContacted} fields={{ lead: id, return: ret }}>Mark contacted</FormBtn>
        <FormBtn action={actWon} fields={{ lead: id, return: ret }} className="primary">Won</FormBtn>
        <FormBtn action={actLost} fields={{ lead: id, return: ret }}>Lost</FormBtn>
        <FormBtn action={actClose} fields={{ lead: id, return: ret }}>Close</FormBtn>
        <form action={actSendToDesigner}>
          <input type="hidden" name="lead" value={id} /><input type="hidden" name="return" value={ret} />
          <select name="designer" required defaultValue=""><option value="" disabled>{designer ? "Reassign to…" : "Send to designer…"}</option>{(designers ?? []).map((d) => <option key={d.id} value={d.id}>{d.name} ({d.specialisation})</option>)}</select>
          <button>Go</button>
        </form>
      </div>

      <h2>Alerts</h2>
      <div className="card">
        <table>
          <thead><tr><th>Alert</th><th>To</th><th>Due</th><th>Sent</th><th>Acted</th></tr></thead>
          <tbody>
            {(notes ?? []).map((n, i) => (
              <tr key={i}><td>{n.type.replace("_", " ")}</td><td>{n.recipient_type.replace("_", " ")}</td><td>{when(n.scheduled_for)}</td>
                <td>{n.sent_at ? when(n.sent_at) : n.cancelled_at ? <span className="muted">cancelled{n.error ? `: ${n.error}` : ""}</span> : "queued"}</td><td>{when(n.acted_at)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Transcript</h2>
      <pre className="transcript">{call?.transcript || "No transcript"}</pre>
    </>
  );
}
