import { fmtWhen } from "@/lib/time";

export const when = (iso: string | null | undefined) => (iso ? fmtWhen(new Date(iso)) : "—");

export function Flash({ msg, err }: { msg?: string; err?: string }) {
  return msg ? <p className={`flash${err ? " err" : ""}`}>{msg}</p> : null;
}

export function ClassBadge({ lead }: { lead: { classification: string | null; call_type?: string | null } }) {
  if (lead.call_type && lead.call_type !== "new_enquiry") return <span className="badge bad">{lead.call_type.replace("_", " ")}</span>;
  const c = lead.classification;
  const tone = c === "qualified" ? "good" : c === "borderline" ? "warn" : c === "not_qualified" ? "bad" : "";
  return <span className={`badge ${tone}`}>{c ? c.replace("_", " ") : "unclassified"}</span>;
}

export function FormBtn({ action, fields, children, className }: { action: (fd: FormData) => void | Promise<void>; fields: Record<string, string>; children: React.ReactNode; className?: string }) {
  return (
    <form action={action}>
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button className={className}>{children}</button>
    </form>
  );
}
