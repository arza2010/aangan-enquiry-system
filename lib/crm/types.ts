/**
 * CRM sync interface. HubSpot is the first implementation (lib/crm/hubspot.ts). The core flow only talks to
 * this interface, so a failing or missing CRM can never block a call being logged, routed or alerted.
 */
export interface CrmLeadPayload {
  lead_id: string;
  caller_name: string | null;
  phone: string; // E.164
  project_type: string;
  location: string | null;
  classification: string | null;
  status: string; // our lead status; the CRM maps it to a deal stage
  handoff_note: string | null; // already price-checked by the caller of sync()
  owner_id: string | null; // designer's HubSpot owner id
  want_deal: boolean; // contact always; deal only once the lead is real
  contact_id?: string | null; // known ids make the sync idempotent
  deal_id?: string | null;
}

export interface CrmSyncResult {
  contact_id: string;
  deal_id?: string;
}

export interface CrmClient {
  sync(p: CrmLeadPayload): Promise<CrmSyncResult>;
}
