CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_owner_name
ON workspaces(owner_id, name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_workspaces_owner_opened
ON workspaces(owner_id, last_opened_at DESC);
