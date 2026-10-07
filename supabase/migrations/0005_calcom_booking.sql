-- Booking moves from per-designer Google Calendars to Cal.com (free tier = ONE account, so one shared consult calendar).
-- The designer is chosen by our routing, not by the calendar, so a booking may exist before it has a designer.
alter table bookings alter column designer_id drop not null;
alter table bookings add column if not exists provider text not null default 'calcom';
alter table bookings add column if not exists provider_booking_uid text;
create unique index if not exists bookings_provider_uid_idx on bookings (provider, provider_booking_uid) where provider_booking_uid is not null;
-- A shared calendar can only hold one consult at a time. (Replaces the per-designer double-book guard.)
drop index if exists bookings_no_double_book;
create unique index bookings_no_double_book on bookings (slot_start) where status in ('provisional', 'confirmed');
