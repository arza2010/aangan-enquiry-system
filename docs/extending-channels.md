# Adding WhatsApp or the web form later

Everything downstream of the channel adapter works on one type, `NormalisedEnquiry` (`lib/channels/types.ts`):

    { channel, external_id, caller_phone, started_at, ended_at, duration_sec, transcript, language, recording_url?, raw }

A new channel therefore needs only a trigger and an input adapter. The AI, routing, alerts, booking, HubSpot sync and dashboard are untouched.

## Steps
1. **Adapter**: add `lib/channels/whatsapp.ts` (or `webform.ts`) exporting `normaliseX(rawPayload): NormalisedEnquiry`. Set `channel` to `"whatsapp"` / `"webform"`. For a chat thread, join messages into `transcript` as `Caller: ...` / `Agent: ...` lines. For a form, render the fields as text (`Name: ...`, `Project type: ...`).
   Use the sender's number / the form's phone field as `caller_phone` (E.164 via `toE164`).
2. **Trigger**: add `app/api/webhooks/whatsapp/route.ts`. Copy `app/api/webhooks/vaani/route.ts`: verify the provider's secret, call your adapter, then `ingestCall` and `processCall` exactly as there. `ingestCall` already dedupes on (channel, external_id).
3. **Nothing else.** `calls.channel` already stores the source, repeat-caller detection already matches on phone across channels, and costs log per call.

## Things to decide per channel
- **Timing:** WhatsApp is conversational, so decide when a thread is "finished" and ready to classify (for example 10 minutes of silence).
- **Booking:** Cal.com booking happens mid-call only on voice. For text channels, send the booking link in the reply, and `linkBookingToCall` will not apply; add a lookup by the attendee's phone instead.
- **Alert wording:** templates say "call"; adjust `lib/notify/templates.ts` for text channels.
- **Prompt:** `prompts/post-call.md` is written for phone transcripts; add a line saying what the channel is.
