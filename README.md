# Aangan Studio · Phone Enquiry System

Answers missed and after-hours calls with a voice AI (Vaani), classifies each enquiry with an LLM, routes qualified leads
to a designer on Telegram with a booked consult, and gives Nikhil a dashboard of response times, outcomes and running cost.

**Hard rules (enforced in code and tests):** never quote a price · never reject or drop a caller (everything is logged;
non-qualified calls go to a human review queue) · only describe services in `services.md` · secrets only in `.env.local` ·
every external call logs its cost.

## How it fits together
```
Caller -> Vaani (voice AI, books a consult in Cal.com)
            | call ends: Vaani PUSHES the transcript to /api/webhooks/vaani
            v
   this app (Next.js on Vercel) -> LLM classifies -> Supabase
        |-> Telegram alerts (front desk group, designers, Nikhil) + Accept / Reassign buttons
        |-> SMS to the caller (simulated until a provider is chosen)
        |-> HubSpot contact + deal
        '-> Review queue + dashboard (staff login)
   /api/cron/tick every minute: reminders, escalations, retries, recovery of any call that lost its lead
```

## Commands
| Command | What it does |
|---|---|
| `npm run dev` | run the app locally |
| `npm test` / `npm run typecheck` / `npm run lint` | checks (138+ tests) |
| `npm run eval` | run the AI over all 23 test transcripts and print a review table |
| `npm run simulate` | full workflow with fake designers: real AI + Telegram, in-memory data |
| `npm run webhook:replay -- T01` | send a transcript to the real webhook as Vaani would |
| `npm run seed:demo` | fill Supabase with a month of demo history |
| `npm run staff:create -- email pw "Name" admin` | create a staff login |
| `npm run vaani:setup` | create/update the voice agent in Vaani |
| `npm run hubspot:check` / `-- --test` | verify HubSpot, read pipeline stages |
| `npm run telegram:setup` / `-- --chats` / `-- --test` | webhook, chat ids, send a hello |

**Start here:** `docs/deploy.md`. Open decisions and assumptions: `docs/open-questions.md`. Voice agent: `docs/vaani-setup.md`.
Adding WhatsApp or the web form: `docs/extending-channels.md`.

## Setup in one minute
```bash
cp .env.example .env.local   # fill in values (never commit it)
npm install && npm run dev
```

### Telegram (needed for alerts)
1. @BotFather -> `/newbot` -> put the token in `TELEGRAM_BOT_TOKEN`; set `TELEGRAM_WEBHOOK_SECRET` to any random string.
2. Add the bot to the front desk group; designers and Nikhil press **Start** on the bot.
3. Send a message in each chat, then `npm run telegram:setup -- --chats` to read the chat ids into `.env.local`.
4. Once deployed on a public https URL: `npm run telegram:setup` registers the button webhook.

### Simulation (no real designers, no database needed)
```bash
npm run simulate                      # T01 T05 T10 T09 S01 through the real AI + routing + Telegram, time x60
npm run simulate -- T13 T18 --speed 120 --minutes 6
npm run simulate -- --at 2026-09-09T22:47:00+05:30    # night-time / quiet-hours demo
```
Three fake designers (Anaya, Bhavin, Chitra) all deliver to one real chat, labelled "🧪 SIMULATION → who it would go to". The Accept/Reassign buttons work live. Nothing persists.

### Booking (Cal.com)
1. cal.com (free) > Settings > Availability: Mon-Sat 10:00-19:00 Asia/Kolkata.
2. Create an event type "Aangan consult", 20 min, 10 min buffers, minimum notice 30 min, location "Attendee phone number".
3. Settings > Developer > API keys > create one -> `CALCOM_API_KEY`. The event type's id (in its URL) -> `CALCOM_EVENT_TYPE_ID`.
4. In Vaani: Settings > Integrations > Cal.com, paste the same key and pick that event type.

### Scheduler
`GET /api/cron/tick` (header `Authorization: Bearer $CRON_SECRET`) must run **every minute**: it sends due alerts and reminders,
escalates overdue leads, retries failures, syncs HubSpot and recovers any call that lost its lead. Vercel's free plan only runs
daily crons (`vercel.json` keeps a daily backup), so use cron-job.org for the per-minute call: see `docs/deploy.md` step 4.
