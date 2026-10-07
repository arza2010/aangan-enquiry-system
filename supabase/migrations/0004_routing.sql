-- Step 4: routing, notifications, HubSpot sync support.

-- A lead is "routed" once the routing/notification step has run for it. Lets cron recover leads whose
-- routing crashed, and makes re-runs idempotent.
alter table leads add column if not exists routed_at timestamptz;
create index if not exists leads_unrouted_idx on leads (created_at) where routed_at is null;

-- Notifications can be cancelled (designer accepted, so the reminder is moot) without being "sent".
alter table notifications add column if not exists cancelled_at timestamptz;
-- Prevents duplicates when cron or a webhook retries (e.g. one digest per day, one new-enquiry alert per lead).
alter table notifications add column if not exists dedupe_key text;
create unique index if not exists notifications_dedupe_idx on notifications (dedupe_key) where dedupe_key is not null;
drop index if exists notifications_due_idx;
create index notifications_due_idx on notifications (scheduled_for) where sent_at is null and cancelled_at is null;

insert into settings (key, value, description, is_placeholder) values
  ('working_days',               '[1,2,3,4,5,6]',   'ISO weekdays the front desk works (1=Mon..7=Sun). PLACEHOLDER: confirm Saturday/Sunday with Nikhil', true),
  ('callback_promise_minutes',   '60',              'Callback promised to callers with no booked slot (in working hours)', false),
  ('after_hours_callback_time',  '"11:00"',         'After-hours callers are promised a callback by this time next working morning', false),
  ('frontdesk_quiet_hours',      'false',           'If true, front desk group alerts also respect quiet hours', false),
  ('hubspot_pipeline_id',        '"default"',       'PLACEHOLDER: HubSpot deal pipeline internal id', true),
  ('hubspot_stage_map',          '{"new":"appointmentscheduled","sent_to_designer":"appointmentscheduled","accepted":"qualifiedtobuy","in_review":"appointmentscheduled","contacted":"presentationscheduled","won":"closedwon","lost":"closedlost","closed":"closedlost"}', 'PLACEHOLDER: our lead status to HubSpot dealstage ids (these are the default-pipeline ids; replace with the portal''s real ones)', true)
on conflict (key) do nothing;

-- Calls that are not new enquiries (existing-client complaint, wrong number) must never be auto-routed to a designer.
alter table leads add column if not exists call_type text not null default 'new_enquiry'
  check (call_type in ('new_enquiry', 'existing_client', 'other'));
