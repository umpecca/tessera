-- Keep legacy documents in their existing columns; only the pane kind changes.
-- Saved text is never interpreted as terminal input or a startup command.
UPDATE workspaces SET revision = lower(hex(randomblob(16)))
WHERE id IN (SELECT workspace_id FROM panes WHERE kind IN ('worksheet', 'text-editor', ''));
UPDATE panes SET kind = 'terminal' WHERE kind IN ('worksheet', 'text-editor', '');
