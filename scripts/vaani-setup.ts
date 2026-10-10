/**
 * Create (or update) the "Aangan Studio" voice agent in Vaani from prompts/vaani-agent.md.
 *   npm run vaani:setup -- --dry-run     show exactly what would be sent, change nothing
 *   npm run vaani:setup                  create the agent, or update it if one with this name already exists
 *   add --no-booking if the booking tools are not set up in Vaani: the agent then only promises a callback window
 *   add --sms-live once a real SMS provider is connected (keeps the "you'll get a confirmation message" line)
 *
 * NOT done here, on purpose: pasting the Cal.com key into Vaani and provisioning a phone number. Both are done by you
 * in Vaani's dashboard (one holds a secret, the other is a purchase).
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { AGENT_NAME, buildAgentConfig, buildSystemPrompt, loadAgentPrompt } from "../lib/vaani-agent";

const dry = process.argv.includes("--dry-run");
const key = process.env.VAANI_API_KEY;
const email = process.env.CALCOM_ATTENDEE_EMAIL;
const prompt = buildSystemPrompt(loadAgentPrompt(), { fallbackEmail: email ?? "", smsLive: process.argv.includes("--sms-live"), booking: !process.argv.includes("--no-booking") });
const cfg = buildAgentConfig(prompt);

if (dry) {
  console.log(`Agent name: ${AGENT_NAME}\nPrompt: ${prompt.length} characters, ${prompt.split(/\s+/).length} words\n`);
  console.log(JSON.stringify({ ...cfg, persona: { ...cfg.persona, identity: { ...cfg.persona.identity, system_prompt: `<${prompt.length} chars: see prompts/vaani-agent.md>` } } }, null, 2));
  console.log("\n(dry run: nothing was sent)");
  process.exit(0);
}
if (!key) {
  console.error("VAANI_API_KEY is not set. In Vaani: Settings > API Keys > Generate API Key, paste it into .env.local.");
  process.exit(1);
}

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`https://api.vaanivoice.ai${path}`, { method, headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`Vaani ${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

async function main() {
  const list = await api("GET", `/api/agents?search=${encodeURIComponent(AGENT_NAME)}&page=1&page_size=50`);
  const existing = ((list.data ?? list) as { id: string; display_name: string; archived?: boolean }[]).find((a) => a.display_name === AGENT_NAME && !a.archived);
  if (existing) {
    console.log(`Agent "${AGENT_NAME}" exists (${existing.id}): updating its prompt and call settings`);
    await api("PATCH", `/api/agent/${existing.id}/persona`, cfg.persona);
    await api("PATCH", `/api/agent/${existing.id}/experience`, cfg.experience);
    console.log("updated");
    return;
  }
  const r = await api("POST", "/api/create-agent", { agent_display_name: AGENT_NAME, config: cfg });
  console.log(`Created agent "${AGENT_NAME}"  id=${r.agent_id}`);
}
main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
