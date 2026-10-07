# Setting up Vaani (the voice that answers the phone)

## Where Vaani fits
Vaani is only the phone-answering robot: it picks up, talks to the caller (speech-to-text, a conversation,
text-to-speech) and, when the caller agrees, books a consult slot in Cal.com. Everything else is our app:

    Caller -> studio number -> (front desk rings ~20s, then) Vaani -> talks, books in Cal.com
                                                               |
                                    when the call ends, Vaani POSTs the transcript to our webhook
                                                               v
              our app: AI classifies -> routes -> Telegram alerts, SMS, HubSpot, dashboard

Vaani never decides who is qualified, never sees pricing, and never talks to designers.

## Part A: build and test the voice agent (no backend needed)
1. Vaani dashboard: create an agent. Name it "Aangan Studio".
2. Persona / identity: language English with Hindi + Marathi if offered; pick a warm, clear Indian-English voice.
3. Greeting (first message): "Hello, Aangan Studio. How can I help you today?"
4. Instructions / system prompt: paste `prompts/vaani-agent.md`, replacing FALLBACK_EMAIL_HERE with the same plain
   address as CALCOM_ATTENDEE_EMAIL. Do NOT paste the internal pricing guide or the qualification rubric into Vaani.
   Also remove the closing sentence about a "confirmation message" until a real SMS provider is connected (today SMS is simulated).
5. Experience settings: max call duration 6 minutes; hang up after ~15s of silence.
6. Settings > Integrations > Cal.com: paste the Cal.com API key and choose the "Aangan Consult" event type.
   Make sure the agent can use it (some platforms need it attached to the agent).
7. Settings > Telephony: provision a number and assign it to the agent (Deployment > Inbound).
8. Call that number from your phone and try: a normal enquiry and book a slot; push hard for a price (it must refuse);
   speak Hindi; ask for a restaurant; say you're an existing client. Check the booking appears in Cal.com.
   Read the transcript in Vaani's call history.

## Part B: connect it to our app (needs the app on a public https URL and Supabase)
1. Supabase project: run supabase/migrations/*.sql then supabase/seed.sql; create staff logins.
2. Deploy (or tunnel with ngrok) so the app has a public https URL; set the env vars there.
3. Vaani > Settings > Webhooks: add
       https://<your-app>/api/webhooks/vaani?token=<VAANI_WEBHOOK_SECRET>
   Only the `call_postprocessing` event matters; the others are ignored.
4. Make a test call; within about a minute the front desk Telegram group should show "New enquiry".

## Part C: the real studio number (later)
Ask the carrier to forward the studio number to the Vaani number: "no answer after ~20 seconds" in hours, and
unconditionally after hours. This is a carrier setting, not code. Test that Vaani sees the CALLER's number, not the
studio's: if it shows the studio's number, repeat-caller detection and SMS confirmation break.
