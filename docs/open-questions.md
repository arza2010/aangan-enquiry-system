# Open questions (ASK items)

Running list. Mark resolved with the answer and date.

## Blocking the next step

| # | Question | Blocks | Status |
|---|---|---|---|
| 1 | Context files | | **resolved 7 Oct**: `services.md`, `qualified.md` in `/context`; `pricing.md` in `/docs-internal` (gitignored); 20 phone transcripts split into `/context/transcripts/phone` (WhatsApp/web-form ones stay in the source PDF for later). |
| 1a | **An LLM key in `.env.local`** (`GEMINI_API_KEY` or `ANTHROPIC_API_KEY`) so `npm run eval` can run. Not on this machine yet. Do not paste it in chat. | Step 3 eval output | open |
| 1b | **Provider choice.** Brief specifies Claude; user only has a Gemini key, so the AI layer is behind `lib/ai/provider.ts` (default `gemini-3.8-flash`, verify with the key). Free-tier Gemini may use prompts to improve Google products, and these are real callers' details: use a paid/billing-enabled key before real calls. Enter the chosen model's real ₹ per 1M tokens in `settings`. If the case is graded on Claude specifically, flip `AI_PROVIDER=anthropic`. | decision noted |
| 2 | Vaani webhook payload | | **resolved 7 Oct from docs.vaanivoice.ai**: event `call_postprocessing` (transcript, summary, duration in ms, recording url). It does NOT carry the caller number or start time, so we look them up via `GET /api/call-history`. No signature scheme documented, so the webhook is protected by `?token=` in the URL. Still to confirm with a real test call: (a) caller number is the real caller, not the studio's, after call forwarding; (b) call-history `Start_time` is UTC; (c) sort order of call-history. |
| 2a | Vaani cost: call-history reports `call_cost` in **credits**. Need Rs per credit (Vaani billing page) for `settings.price_vaani_inr_per_credit`. | open |
| 3 | Vaani mid-call tools | | **sidestepped 7 Oct**: Vaani has a native Cal.com integration (Settings > Integrations), so it books mid-call without calling our endpoints. Our `/api/booking/availability` and `/book` stay available (secret `x-tool-secret`) if Vaani turns out to support HTTP tools or MCP. |

## HubSpot (new requirement): decided by default 7 Oct, change if wrong

| # | Decision | Status |
|---|---|---|
| 4-6 | One-way sync (us to HubSpot). Contact for every caller (matched by phone); Deal created when a lead is qualified, or when front desk sends a borderline lead to a designer. Not-qualified stay contact-only. | decided |
| 7 | Private App access token (`HUBSPOT_ACCESS_TOKEN`). Still need to know: which HubSpot account/plan, and any existing custom properties or pipeline to reuse. | token decided, account details open |
| 8 | Designer = HubSpot owner via `designers.hubspot_owner_id`. Need the owner list. | open (with designer list) |
| 9 | HubSpot mirrors our data; it does not replace our lead page or won/lost tracking. Stages: New, Accepted, Contacted, Won, Lost. | decided |

Design: HubSpot sits behind `lib/crm/types.ts`, runs async, and a HubSpot failure never blocks logging, routing or alerts. Sync state is tracked per lead (`hubspot_sync_status`, `hubspot_contact_id`, `hubspot_deal_id`), retried by cron. Only the price-checked handoff note is synced.

## Needed before deploy

| # | Question | Status |
|---|---|---|
| 10 | Designer list: name, specialisation, areas, Telegram chat id, calendar id | open (seeded with placeholders) |
| 11 | Google Workspace / Google Calendar | | **dropped 7 Oct**: booking uses Cal.com instead (see #35-#40). |
| 12 | SMS provider (behind `lib/sms.ts`) | open |
| 13 | Hosting: Vercel or Netlify (affects cron config) | open |
| 14 | Scheduler: Vercel Cron / Netlify Scheduled Functions every minute OK? (Vercel Hobby limits cron to daily; every-minute needs Pro) | open |
| 15 | Real unit prices for `settings` (Vaani ₹/min, LLM, SMS, hosting) and Nikhil's baseline response/conversion rates | open (placeholders, `is_placeholder = true`) |
| 16 | Confirm current Claude model string for the post-call step | open (`claude-sonnet-5-5` per brief) |

## Found in the seed data (need Nikhil's decision)

| # | Finding | Status |
|---|---|---|
| 17 | **Existing-client complaint (T09, Sheetal / Viman Nagar).** Not an enquiry; she asked for Nikhil to call back within 15 min. The brief's JSON has no way to say this, so I added `call_type: new_enquiry / existing_client / other`. Anything not `new_enquiry` goes to review, never auto-routed to a designer. Step 4 should alert Nikhil directly for `existing_client`. Remove the field if you disagree. | decision needed |
| 18 | **Lead-time conflict.** `qualified.md`: site ready within 8-10 weeks of consult. `services.md`: cannot start execution if ready in under 6 weeks. T07 (front desk) used 8-10 weeks; T15 (possession in 6 weeks) was accepted. The LLM is given both documents verbatim, so edge cases may flip. Which rule is right? | open |
| 19 | **Minimum office size.** T18 was declined at 180 sq ft citing "500 sq ft minimum for commercial", but `services.md` only states a 3,000 sq ft maximum. The LLM is told not to invent thresholds, so a small office would come out `borderline`, not `not_qualified`. Is there a real minimum? | open |
| 20 | **What counts as "price mentioned".** Brief says flag if "agent or caller stated a number". Implemented as: a price/rate/estimate for Aangan's services stated by either side. A caller's own budget is stored in `budget_range` and does NOT flag (otherwise most leads would hit the review queue). Confirm. | decision needed |
| 21 | **Site visits.** T05 and T12 promised site-visit consults. Brief says Vaani books 15-20 min calls only and site visits need a designer's judgement. Handoff note will mention the request; designer arranges it. Fine? | open |
| 22 | **Repeat callers** (T16 chasing a lost enquiry; T17 dropped call then redial 2 min later). Repeat flag is set by phone number; step 4 should link/merge the T17 pattern instead of creating two leads. | planned step 4 |
| 23 | The real transcripts are human front desk. Vaani-led calls will read differently, so re-run the eval on a few real Vaani calls once they exist. | later |
| 24 | **Eval v1 (7 Oct, gemini-3.8-flash, 23 transcripts)** led to three prompt rules that need Nikhil's sign-off: (a) a criterion that was never discussed (e.g. timeline) does NOT downgrade a call; it stays `qualified` with the gap in `missing_info`, otherwise ~40% of calls went to the review queue; (b) classification uses the caller's final position (T07: "what if I start after Diwali?" is borderline, not rejected); (c) there is no minimum project size, so a 180 sq ft pod is borderline pending a human, not auto-declined (see #19). | decision needed |
| 25 | `price_mentioned_in_call` now also fires when a caller cites a competitor's rate or asks "is it under 30 lakh?" (S01/S03 were missed before). A caller's own stated budget still does not fire it. | refines #20 |

## Step 4 (routing, Telegram, scheduler, HubSpot): decisions made by default, change if wrong

| # | Item | Status |
|---|---|---|
| 26 | **Telegram setup needed to go live:** create the bot with @BotFather (token), add it to the front desk group, then `npm run telegram:setup -- --chats` lists chat ids (send any message first). Designers must press Start on the bot once, or Telegram refuses to message them. Telegram only calls a **public https** URL, so local testing needs ngrok. | open |
| 27 | **Working days.** Assumed Mon-Sat (`settings.working_days`). Is Sunday closed? Affects SLA deadlines for Saturday-evening calls. | open |
| 28 | **Callback promise** for callers with no booked slot: 60 min in hours, 11:00 next working morning out of hours (`callback_promise_minutes`, `after_hours_callback_time`). Vaani's agent prompt must say the same time. | decision needed |
| 29 | **Cron frequency.** `vercel.json` runs the tick every minute. Vercel Hobby only allows daily crons, so the 10-min reminder and SLA escalation need Vercel Pro, or an external pinger (e.g. cron-job.org hitting `/api/cron/tick` with the bearer secret), or Netlify scheduled functions. | open (ties to #13, #14) |
| 30 | **HubSpot** | | **verified 7 Oct**: service key works (private apps are being phased out; service keys are the replacement, used as a Bearer token), default "Sales Pipeline" (`default`) with the stage ids we assumed, create/update/delete round trip OK through our real sync code, notes OK. Only one owner exists (the account holder), so designers have no HubSpot owner yet: deals are created unassigned. Free-tier contact cap (page says 1,000; may be marketing contacts only) still unconfirmed. | done |
| 31 | **Booking confirmation** sets the booking to `confirmed` in the database only. Renaming the calendar event (drop "[Provisional]") and moving it on Reassign are step 5. | planned |
| 32 | **Existing-client complaints** alert Nikhil + front desk (never a designer) and get no "enquiry received" SMS. See #17. | decision needed |
| 33 | **Digest** counts the last 24 h and is sent on the first cron tick after 09:30 IST each day. | done |
| 34 | A designer's **Reassign** picks the next matching designer automatically. Should it instead ask the front desk? | decision needed |

## Step 5 (booking on Cal.com instead of Google Calendar)

| # | Item | Status |
|---|---|---|
| 35 | **Cal.com free tier = one account, no teams.** Round-robin / team scheduling is paid (about $12 per user per month). So there is ONE shared consult calendar: one consult at a time, and the calendar does not know which designer. Our routing picks the designer after the call; Cal.com just holds the time. Fine for a pilot; for per-designer calendars upgrade to Teams, or each designer gets their own account (14 API keys). | decision noted |
| 36 | **Verify the free plan has what we need** (I could not confirm from public pages): Cal.com > Settings > Developer > **API keys** must let you create one. If it asks you to upgrade, tell me: fallback is a built-in availability engine in our own database (no external calendar, $0). Calendly: I could not check its docs; as far as I know creating bookings via its API is paid-only and Vaani has no native Calendly integration, so Cal.com is the better fit. | open |
| 37 | **Cal.com emails the caller "confirmed"** the moment Vaani books, even though our rule is "provisional until the lead qualifies". If the front desk later cancels, the caller gets a cancellation email plus our SMS. Turning on "requires confirmation" on the event type would fix it; I don't know if the free plan allows it. | open |
| 38 | **Cal.com rejects fake attendee emails** (tested 7 Oct: `example.com` -> "email_domain_cannot_receive_mail"). We plus-address a real studio inbox (`CALCOM_ATTENDEE_EMAIL`, e.g. frontdesk@x.com becomes frontdesk+caller9876543210@x.com). **Bigger risk:** Vaani's NATIVE Cal.com booking has to supply an email too. If it asks callers for one, fine; if it cannot, native booking fails and we switch to our own endpoints (we supply the email) or the post-call booking fallback. Needs one real Vaani test. | open |
| 39 | **How we find the booking Vaani made:** after the call we list Cal.com bookings created during the call's time window and match on the caller's phone (or the only one in the window). Never guesses between two. Needs one real test call to confirm Vaani fills in the phone number on the booking. | needs a real call |
| 40 | **Fallback booking** (agent can't book, so caller picks morning/afternoon/evening and we book after the call) is not built: with Cal.com native booking it is rarely needed. Say if you want it. | not built |
| 41 | **Front desk Keep/Cancel** buttons (step 6) call `cancelBooking`, which deletes the Cal.com booking and queues the polite SMS. The Cal.com cancel API is built and tested; the buttons and SMS wording come with the review queue. | planned step 6 |

## Status at hand-over (7 Oct 2026)

**Built and tested (138 unit/flow tests, typecheck, lint, production build):** Vaani webhook + adapter, AI classification (Gemini or Claude),
routing, Telegram alerts/reminders/escalation/quiet hours/digest with live Accept and Reassign, Cal.com booking (mid-call, link, confirm,
cancel, sync), HubSpot contact+deal sync (live-verified), front desk review queue with Keep/Cancel, lead page, Nikhil's dashboard, staff login,
simulator, webhook replay, demo seed, deploy guide.

**Needs your accounts / a live check (cannot be verified from code):**
1. Supabase project + migrations + `staff:create` + `seed:demo` (docs/deploy.md part 1-2). The screens have never run against a real database.
2. Vercel deploy + cron-job.org every-minute tick (parts 3-4).
3. Vaani: `VAANI_API_KEY`, `npm run vaani:setup`, Cal.com key in Vaani, then one browser test call. Unknown until tried: does Vaani's Cal.com booking
   supply an email and phone; does a browser call fire `call_postprocessing`; is the caller number visible.
4. Real unit prices in `settings` (dashboard flags placeholders).

**Not built, by decision (assignment scope, ~20 days):** real SMS provider (simulated), carrier call-forwarding, real designers (simulated), fallback
post-call booking, per-designer calendars, WhatsApp / web form (see docs/extending-channels.md).
