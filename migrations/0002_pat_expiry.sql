-- Personal access tokens gained an expires_at column after 0001 shipped.
ALTER TABLE personal_access_tokens ADD COLUMN expires_at TEXT;
