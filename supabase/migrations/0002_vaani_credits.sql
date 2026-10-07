-- Vaani reports each call's cost in "credits" (GET /api/call-history -> call_cost), which is more accurate
-- than guessing from minutes. Needs the real ₹ per credit from the Vaani billing page.
insert into settings (key, value, description, is_placeholder) values
  ('price_vaani_inr_per_credit', '0', 'PLACEHOLDER: ₹ per Vaani credit (call_cost is billed in credits)', true)
on conflict (key) do nothing;
