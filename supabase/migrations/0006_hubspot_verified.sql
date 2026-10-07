-- Verified against the real HubSpot account on 7 Oct 2026 (`npm run hubspot:check`): default "Sales Pipeline", stage ids as mapped.
update settings set is_placeholder = false, description = 'HubSpot deal pipeline internal id (verified 7 Oct 2026)' where key = 'hubspot_pipeline_id';
update settings set is_placeholder = false, description = 'Our lead status -> HubSpot dealstage id (verified 7 Oct 2026 against the default Sales Pipeline)' where key = 'hubspot_stage_map';
