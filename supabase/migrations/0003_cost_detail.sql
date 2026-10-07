-- Which provider/model produced a cost line (e.g. "gemini:gemini-3.8-flash"), so the dashboard can compare.
alter table cost_events add column if not exists detail text;
