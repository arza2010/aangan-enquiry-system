import type { CrmClient, CrmLeadPayload } from "./types";

/** All HubSpot paths live here: HubSpot is moving to date-versioned URLs, so this is the one place to change. */
const BASE = "https://api.hubapi.com";
const PATH = {
  contactSearch: "/crm/v3/objects/contacts/search",
  contacts: "/crm/v3/objects/contacts",
  deals: "/crm/v3/objects/deals",
  notes: "/crm/v3/objects/notes",
  associate: (from: "deals" | "notes", id: string, to: "contacts" | "deals", toId: string) =>
    `/crm/v4/objects/${from}/${id}/associations/default/${to}/${toId}`,
};

export interface HubspotConfig {
  token: string;
  pipeline: string;
  stageMap: Record<string, string>; // our lead status -> HubSpot dealstage id
  f?: typeof fetch;
}

export function hubspotClient(cfg: HubspotConfig): CrmClient {
  const f = cfg.f ?? fetch;

  async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await f(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HubSpot ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? {} : await res.json()) as T;
  }

  const contactProps = (p: CrmLeadPayload) => {
    const [first, ...rest] = (p.caller_name ?? "").trim().split(/\s+/).filter(Boolean);
    return {
      phone: p.phone,
      ...(first ? { firstname: first } : {}),
      ...(rest.length ? { lastname: rest.join(" ") } : {}),
      ...(p.location ? { city: "Pune" } : {}),
    };
  };

  async function ensureContact(p: CrmLeadPayload): Promise<string> {
    if (p.contact_id) {
      await api("PATCH", `${PATH.contacts}/${p.contact_id}`, { properties: contactProps(p) });
      return p.contact_id;
    }
    const found = await api<{ results: { id: string }[] }>("POST", PATH.contactSearch, {
      filterGroups: [{ filters: [{ propertyName: "phone", operator: "EQ", value: p.phone }] }],
      properties: ["phone"],
      limit: 1,
    });
    if (found.results[0]) {
      await api("PATCH", `${PATH.contacts}/${found.results[0].id}`, { properties: contactProps(p) });
      return found.results[0].id;
    }
    return (await api<{ id: string }>("POST", PATH.contacts, { properties: contactProps(p) })).id;
  }

  const dealName = (p: CrmLeadPayload) =>
    `${p.caller_name ?? p.phone} · ${p.project_type === "office" ? "Office" : p.project_type === "home" ? "Home" : "Project"}${p.location ? ` · ${p.location}` : ""}`;

  return {
    async sync(p) {
      const contact_id = await ensureContact(p);
      if (!p.want_deal) return { contact_id };

      const stage = cfg.stageMap[p.status] ?? cfg.stageMap.new;
      const props = {
        dealname: dealName(p),
        pipeline: cfg.pipeline,
        dealstage: stage,
        ...(p.owner_id ? { hubspot_owner_id: p.owner_id } : {}),
      };

      if (p.deal_id) {
        await api("PATCH", `${PATH.deals}/${p.deal_id}`, { properties: props });
        return { contact_id, deal_id: p.deal_id };
      }
      const deal = await api<{ id: string }>("POST", PATH.deals, { properties: props });
      await api("PUT", PATH.associate("deals", deal.id, "contacts", contact_id));
      if (p.handoff_note) {
        // The note is a nice-to-have. A private app without the notes scope must not fail the whole sync (the deal already exists).
        try {
          const note = await api<{ id: string }>("POST", PATH.notes, { properties: { hs_note_body: p.handoff_note, hs_timestamp: Date.now() } });
          await api("PUT", PATH.associate("notes", note.id, "deals", deal.id));
        } catch (e) {
          console.warn("HubSpot note skipped:", e instanceof Error ? e.message.slice(0, 200) : e);
        }
      }
      return { contact_id, deal_id: deal.id };
    },
  };
}

/** Build from env + settings, or null when HubSpot is not configured (sync is then skipped, never an error). */
export function hubspotFromEnv(settings: Record<string, unknown>, f?: typeof fetch): CrmClient | null {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return null;
  return hubspotClient({
    token,
    pipeline: typeof settings.hubspot_pipeline_id === "string" ? settings.hubspot_pipeline_id : "default",
    stageMap: (settings.hubspot_stage_map as Record<string, string>) ?? {},
    f,
  });
}
