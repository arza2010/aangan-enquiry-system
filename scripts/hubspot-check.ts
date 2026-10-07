/**
 * Verify the HubSpot connection and read the real pipeline.
 *   npm run hubspot:check            token works? list deal pipelines + stage ids, owners, suggested stage map
 *   npm run hubspot:check -- --test  also create a throwaway contact + deal through our real sync code, then delete them
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { hubspotClient } from "../lib/crm/hubspot";
import { suggestStageMap, type HubspotStage } from "../lib/crm/stages";

const token = process.env.HUBSPOT_ACCESS_TOKEN;
if (!token) {
  console.error("HUBSPOT_ACCESS_TOKEN is not set in .env.local");
  process.exit(1);
}
const get = async (path: string, method = "GET") => {
  const r = await fetch(`https://api.hubapi.com${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

async function main() {
  const p = await get("/crm/v3/pipelines/deals");
  if (p.status !== 200) {
    console.error(`Token rejected or missing the deals scope (HTTP ${p.status}): ${JSON.stringify(p.body).slice(0, 300)}`);
    process.exit(1);
  }
  console.log("✓ token works\n");
  const pipelines = p.body.results as { id: string; label: string; stages: HubspotStage[] }[];
  for (const pl of pipelines) {
    console.log(`Pipeline "${pl.label}"  id=${pl.id}`);
    console.table(pl.stages.sort((a, b) => a.displayOrder - b.displayOrder).map((s) => ({ stage_id: s.id, label: s.label, closed: String(s.metadata?.isClosed), probability: s.metadata?.probability })));
  }
  const pl = pipelines[0];
  let map: Record<string, string> = {};
  try {
    map = suggestStageMap(pl.stages);
    console.log(`Suggested mapping for pipeline "${pl.label}" (copy into the settings table):`);
    console.log(`  hubspot_pipeline_id = ${JSON.stringify(pl.id)}`);
    console.log(`  hubspot_stage_map   = ${JSON.stringify(map)}\n`);
  } catch (e) {
    console.log("Could not suggest a stage map:", e instanceof Error ? e.message : e);
  }

  const o = await get("/crm/v3/owners?limit=100");
  console.log(o.status === 200 ? "Owners (use these ids for designers.hubspot_owner_id):" : `Owners: HTTP ${o.status} (add the crm.objects.owners.read scope to list them)`);
  if (o.status === 200) console.table((o.body.results as any[]).map((x) => ({ owner_id: x.id, name: `${x.firstName ?? ""} ${x.lastName ?? ""}`.trim(), email: x.email }))); // eslint-disable-line @typescript-eslint/no-explicit-any

  if (process.argv.includes("--test")) {
    console.log("\nCreating a throwaway contact + deal through the real sync code...");
    const crm = hubspotClient({ token: token!, pipeline: pl.id, stageMap: map });
    const r = await crm.sync({
      lead_id: "test", caller_name: "ZZ Aangan Test", phone: "+919999900001", project_type: "home", location: "Baner", classification: "qualified",
      status: "new", handoff_note: "Setup test, safe to delete.", owner_id: null, want_deal: true,
    });
    console.log("created:", r);
    const upd = await crm.sync({ lead_id: "test", caller_name: "ZZ Aangan Test", phone: "+919999900001", project_type: "home", location: "Baner", classification: "qualified", status: "accepted", handoff_note: null, owner_id: null, want_deal: true, contact_id: r.contact_id, deal_id: r.deal_id });
    console.log("moved to the 'accepted' stage:", upd);
    const d = await get(`/crm/v3/objects/deals/${r.deal_id}`, "DELETE");
    const c = await get(`/crm/v3/objects/contacts/${r.contact_id}`, "DELETE");
    console.log(`cleanup: deal ${d.status === 204 ? "deleted" : "HTTP " + d.status}, contact ${c.status === 204 ? "deleted" : "HTTP " + c.status}`);
  }
}
main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
