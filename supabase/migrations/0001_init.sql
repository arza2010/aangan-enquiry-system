-- Aangan Studio: phone enquiry system. Initial schema.
-- All timestamps are timestamptz (stored UTC). Business-hour logic runs in Asia/Kolkata in app code.

create extension if not exists "pgcrypto";

-- ───────────────────────── enums ─────────────────────────
create type project_type          as enum ('home', 'office', 'unknown');
create type possession_status     as enum ('ready', 'under_construction', 'unknown');
create type classification        as enum ('qualified', 'borderline', 'not_qualified');
create type lead_status           as enum ('new', 'sent_to_designer', 'accepted', 'in_review', 'contacted', 'won', 'lost', 'closed');
create type booking_status        as enum ('provisional', 'confirmed', 'cancelled', 'completed', 'no_show');
create type designer_specialism   as enum ('home', 'office', 'both');
create type cost_service          as enum ('vaani', 'llm', 'sms', 'telegram');
create type crm_sync_status       as enum ('pending', 'synced', 'failed', 'skipped');

-- ───────────────────────── helpers ─────────────────────────
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ───────────────────────── staff (who may log in and read) ─────────────────────────
-- Supabase Auth lets anyone sign up unless disabled. RLS keys off this table, not off "is authenticated",
-- so an unexpected signup still sees nothing.
create table staff_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null default 'front_desk' check (role in ('front_desk', 'designer', 'admin')),
  full_name  text,
  created_at timestamptz not null default now()
);

create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff_users where user_id = auth.uid());
$$;

-- ───────────────────────── designers ─────────────────────────
create table designers (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  telegram_chat_id    text,
  specialisation      designer_specialism not null default 'both',
  areas_served        text[] not null default '{}',   -- Pune localities, lowercase
  active              boolean not null default true,
  night_alerts        boolean not null default false, -- opted in to alerts during quiet hours
  google_calendar_id  text,                           -- designer's calendar for booking (§8B)
  hubspot_owner_id    text,                           -- maps designer to a HubSpot owner
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger designers_updated_at before update on designers for each row execute function set_updated_at();

-- ───────────────────────── calls ─────────────────────────
create table calls (
  id            uuid primary key default gen_random_uuid(),
  channel       text not null default 'phone',        -- phone now; whatsapp / webform later
  external_id   text not null,                        -- Vaani call id
  caller_phone  text not null,                        -- E.164
  started_at    timestamptz not null,
  ended_at      timestamptz,
  duration_sec  integer,
  transcript    text not null default '',
  language      text,
  recording_url text,
  repeat_caller boolean not null default false,
  after_hours   boolean not null default false,
  raw           jsonb not null,                       -- original provider payload, for audit only
  created_at    timestamptz not null default now(),
  unique (channel, external_id)                       -- webhook retries are idempotent
);
create index calls_phone_idx   on calls (caller_phone);
create index calls_started_idx on calls (started_at desc);

-- ───────────────────────── leads ─────────────────────────
create table leads (
  id                      uuid primary key default gen_random_uuid(),
  call_id                 uuid not null unique references calls(id) on delete cascade,
  status                  lead_status not null default 'new',

  -- extraction (null = not said, never guessed)
  caller_name             text,
  project_type            project_type not null default 'unknown',
  location                text,
  carpet_area_sqft        numeric,
  bhk_or_rooms            text,
  scope                   text,
  budget_range            text,
  timeline                text,
  possession_status       possession_status not null default 'unknown',
  source                  text,
  language                text,

  -- classification
  classification          classification,
  classification_reason   text,
  missing_info            text[] not null default '{}',
  handoff_note            text,
  price_mentioned_in_call boolean not null default false,

  -- review flags: anything here lands in the front desk queue
  needs_review            boolean not null default false,
  review_reason           text,

  -- routing + SLA
  assigned_designer_id    uuid references designers(id),
  callback_due_at         timestamptz,                -- promised to caller
  sla_due_at              timestamptz,                -- designer must Accept by this time
  accepted_at             timestamptz,
  first_response_at       timestamptz,                -- first contact with the caller
  outcome_at              timestamptz,                -- won / lost timestamp

  -- HubSpot (scope TBC; see docs/open-questions.md)
  hubspot_contact_id      text,
  hubspot_deal_id         text,
  hubspot_sync_status     crm_sync_status not null default 'pending',
  hubspot_synced_at       timestamptz,
  hubspot_sync_error      text,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create trigger leads_updated_at before update on leads for each row execute function set_updated_at();
create index leads_status_idx    on leads (status);
create index leads_designer_idx  on leads (assigned_designer_id, status);
create index leads_review_idx    on leads (needs_review) where needs_review;
create index leads_sla_idx       on leads (sla_due_at) where accepted_at is null;
create index leads_hubspot_idx   on leads (hubspot_sync_status) where hubspot_sync_status in ('pending', 'failed');

-- Open leads per designer, computed live so it can never drift (routing picks the fewest).
create view designer_open_leads with (security_invoker = true) as
select d.id as designer_id, count(l.id)::int as open_leads
from designers d
left join leads l
  on l.assigned_designer_id = d.id
 and l.status in ('sent_to_designer', 'accepted', 'in_review', 'contacted')
group by d.id;

-- ───────────────────────── bookings ─────────────────────────
-- Vaani books mid-call, BEFORE the webhook creates the call/lead rows, so we key on Vaani's call id
-- and link call_id / lead_id afterwards.
create table bookings (
  id                 uuid primary key default gen_random_uuid(),
  vaani_call_id      text not null,
  call_id            uuid references calls(id) on delete set null,
  lead_id            uuid references leads(id) on delete set null,
  designer_id        uuid not null references designers(id),
  calendar_event_id  text,
  slot_start         timestamptz not null,
  slot_end           timestamptz not null,
  caller_name        text,
  caller_phone       text,
  status             booking_status not null default 'provisional',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (slot_end > slot_start),
  unique (vaani_call_id, slot_start)                  -- idempotent: same call + slot = one booking
);
create trigger bookings_updated_at before update on bookings for each row execute function set_updated_at();
create index bookings_lead_idx on bookings (lead_id);
-- Hard stop on double-booking a designer, independent of the calendar check.
create unique index bookings_no_double_book
  on bookings (designer_id, slot_start) where status in ('provisional', 'confirmed');

-- ───────────────────────── notifications ─────────────────────────
create table notifications (
  id                  uuid primary key default gen_random_uuid(),
  lead_id             uuid references leads(id) on delete cascade,
  recipient_type      text not null check (recipient_type in ('designer', 'front_desk', 'nikhil', 'caller')),
  recipient_chat_id   text,                            -- telegram chat id or phone number for SMS
  channel             text not null check (channel in ('telegram', 'sms')),
  type                text not null,                   -- new_enquiry | lead_assigned | reminder | sla_breach | call_reminder | needs_review | digest | caller_sms
  payload             jsonb not null default '{}',
  scheduled_for       timestamptz not null default now(),
  sent_at             timestamptz,
  delivered           boolean,
  telegram_message_id bigint,
  error               text,
  attempts            integer not null default 0,
  acted_at            timestamptz,                     -- e.g. designer tapped Accept
  created_at          timestamptz not null default now()
);
-- The cron job asks: "what is due and unsent?"
create index notifications_due_idx  on notifications (scheduled_for) where sent_at is null;
create index notifications_lead_idx on notifications (lead_id);

-- ───────────────────────── cost_events ─────────────────────────
create table cost_events (
  id         uuid primary key default gen_random_uuid(),
  call_id    uuid references calls(id) on delete set null,
  service    cost_service not null,
  units      numeric not null,
  unit_type  text not null,                            -- minutes | input_tokens | output_tokens | messages
  cost_inr   numeric(12, 4) not null,
  created_at timestamptz not null default now()
);
create index cost_events_created_idx on cost_events (created_at desc);
create index cost_events_call_idx    on cost_events (call_id);

-- ───────────────────────── settings ─────────────────────────
-- Key/value so values can change without a deploy. is_placeholder = true means "not a real number yet".
create table settings (
  key            text primary key,
  value          jsonb not null,
  description    text,
  is_placeholder boolean not null default false,
  updated_at     timestamptz not null default now()
);
create trigger settings_updated_at before update on settings for each row execute function set_updated_at();

insert into settings (key, value, description, is_placeholder) values
  ('timezone',                 '"Asia/Kolkata"',         'All timers and business hours use this', false),
  ('working_hours',            '{"start":"10:00","end":"19:00"}', 'Front desk hours', false),
  ('price_vaani_inr_per_min',  '0',                      'PLACEHOLDER: Vaani cost per minute (₹)', true),
  ('price_llm_inr_per_m_input','0',                      'PLACEHOLDER: LLM ₹ per 1M input tokens', true),
  ('price_llm_inr_per_m_output','0',                     'PLACEHOLDER: LLM ₹ per 1M output tokens', true),
  ('price_sms_inr_per_message','0',                      'PLACEHOLDER: SMS ₹ per message', true),
  ('price_telegram_inr_per_message','0',                 'Telegram Bot API is free', false),
  ('monthly_hosting_inr',      '0',                      'PLACEHOLDER: Vercel/Netlify + Supabase monthly (₹)', true),
  ('sla_accept_minutes',       '30',                     'Designer must Accept within this many minutes (working hours)', false),
  ('sla_after_hours_deadline', '"10:30"',                'After-hours calls: Accept by this time next working morning', false),
  ('reminder_after_minutes',   '10',                     'Nudge designer if not accepted', false),
  ('call_reminder_minutes',    '15',                     'Remind designer before a booked call', false),
  ('quiet_hours',              '{"start":"21:00","end":"08:00"}', 'Designer alerts queued, sent at end', false),
  ('digest_time',              '"09:30"',                'Daily overnight digest', false),
  ('slot_minutes',             '20',                     'Consultation call length', false),
  ('slot_buffer_minutes',      '10',                     'Buffer around consultations', false),
  ('slot_min_lead_minutes',    '30',                     'Earliest bookable slot from now', false),
  ('slot_horizon_hours',       '48',                     'Latest bookable slot from now', false),
  ('project_value_range_lakh', '{"min":8,"max":14}',     'Indicative average project value (₹ lakh), from the case brief', false),
  ('baseline_response_rate',   'null',                   'PLACEHOLDER: from Nikhil''s manual pull (brief: ~52% answered in 48h)', true),
  ('baseline_conversion_rate', 'null',                   'PLACEHOLDER: from Nikhil''s manual pull', true);

-- ───────────────────────── Row Level Security ─────────────────────────
-- Staff can read. All writes go through server code using the service role (which bypasses RLS),
-- after the server has checked the caller is staff. Anon + non-staff users see nothing.
alter table staff_users   enable row level security;
alter table designers     enable row level security;
alter table calls         enable row level security;
alter table leads         enable row level security;
alter table bookings      enable row level security;
alter table notifications enable row level security;
alter table cost_events   enable row level security;
alter table settings      enable row level security;

create policy staff_read_self   on staff_users   for select to authenticated using (user_id = auth.uid() or is_staff());
create policy staff_read        on designers     for select to authenticated using (is_staff());
create policy staff_read        on calls         for select to authenticated using (is_staff());
create policy staff_read        on leads         for select to authenticated using (is_staff());
create policy staff_read        on bookings      for select to authenticated using (is_staff());
create policy staff_read        on notifications for select to authenticated using (is_staff());
create policy staff_read        on cost_events   for select to authenticated using (is_staff());
create policy staff_read        on settings      for select to authenticated using (is_staff());
