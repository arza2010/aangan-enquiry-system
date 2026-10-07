# Deploy (free tier, about 45 minutes)

Order matters. Do each part, then run its check before moving on.

## 1. Supabase (database + staff login)
1. supabase.com > New project (free). Save the database password. Region: Mumbai if offered.
2. SQL Editor > run, in order, each file in `supabase/migrations/` (0001 ... 0006), then `supabase/seed.sql`.
3. Project Settings > API: copy **Project URL**, **anon key**, **service_role key**.
4. Authentication > Providers > Email: turn **off** "Confirm email" (simplest for a pilot) and turn **off** "Allow new users to sign up".
5. Put the three values in `.env.local` as `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
   The service_role key is a master key: only in `.env.local` and Vercel's env settings, never in chat or git.
6. Create your login:
   `npm run staff:create -- you@example.com 'a-strong-password' "Your Name" admin`
7. **Check:** `npm run dev`, open http://localhost:3000, sign in. You should see an empty review queue.

## 2. Fill it with demo data (so the dashboard has something to show)
`npm run seed:demo` (about 3 minutes: it runs the real AI over the 23 transcripts twice, back-dated over 28 days).
Telegram, SMS and Cal.com are silenced, and every pending alert is cancelled afterwards. Remove it later with `npm run seed:demo -- --wipe`.
**Check:** the dashboard shows calls, qualified leads, response times and costs; the review queue has cards.
Costs use illustrative rates and the dashboard says so. Replace them with real ones in the `settings` table.

## 3. Vercel (hosting)
1. Push the project to a GitHub repository (`.env.local` is git-ignored: do not commit it).
2. vercel.com > Add New > Project > import the repo. Framework: Next.js (auto).
3. Settings > Environment Variables: add every value from `.env.local` (names in `.env.example`).
   Set `APP_BASE_URL` to the final https URL, e.g. https://aangan-xyz.vercel.app (deploy once, then edit it, then redeploy).
4. **Check:** open the URL, sign in, see the demo data.

## 4. The every-minute scheduler (free)
Vercel's free plan only runs a daily cron, but reminders (10 min) and escalations (30 min) need a tick every minute.
cron-job.org (free) > Create cronjob:
- URL: `https://<your-app>/api/cron/tick`
- Schedule: every 1 minute
- Advanced > Headers: `Authorization` = `Bearer <your CRON_SECRET>`
**Check:** its history shows HTTP 200 and `{"ok":true,...}`.

## 5. Telegram buttons
Set `APP_BASE_URL=https://<your-app>` in `.env.local` (temporarily) and run `npm run telegram:setup`.
**Check:** it prints "Webhook set". Run `npm run webhook:replay -- T01 --url https://<your-app>` (step 7) and tap Accept in Telegram.
Remember: `npm run telegram:setup -- --chats` stops working once the webhook is set. Designers get their chat id by sending /start to the bot.

## 6. Vaani
1. `npm run vaani:setup` (needs `VAANI_API_KEY`) creates the agent from `prompts/vaani-agent.md`.
2. In Vaani: Settings > Integrations > Cal.com (paste your key, choose "Aangan Consult"); Settings > Webhooks > add
   `https://<your-app>/api/webhooks/vaani?token=<VAANI_WEBHOOK_SECRET>`.
3. Talk to the agent from Vaani's browser test (no phone number needed). **Check:** the call appears in the review queue / Telegram within about a minute.

## 7. No phone? Replay a call through the real webhook
`npm run webhook:replay -- T01 T10 S01 --url https://<your-app> --phone +919812345678`
Each one goes through the real AI, routing, Telegram, Cal.com lookup, HubSpot sync and the dashboard, exactly as a Vaani call would.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| Sign-in says "not set up as staff" | Run `staff:create` (adds the `staff_users` row RLS checks) |
| Dashboard empty after seed | Seed failed part-way (read its output); or wrong date range |
| Telegram alerts never arrive | chat ids in Vercel env; designer never pressed Start; see `notifications.error` in Supabase |
| Reminders/escalations late | cron-job.org not running every minute |
| Webhook returns 401 | `?token=` does not match `VAANI_WEBHOOK_SECRET` in Vercel |
| Cal.com booking fails | `CALCOM_ATTENDEE_EMAIL` must be a real inbox; key or event type id wrong |
