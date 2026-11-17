-- Persist the mapping confirmed in /import/:token/preview so /execute applies
-- the user's choices instead of re-guessing from headers.
ALTER TABLE import_jobs ADD COLUMN mapping_json TEXT;
ALTER TABLE import_jobs ADD COLUMN dedup_strategy TEXT;
ALTER TABLE import_jobs ADD COLUMN auto_tag_names_json TEXT;
