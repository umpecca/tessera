-- Preserve pane identity/layout while invalidating pre-retirement clients.
UPDATE workspaces SET revision = lower(hex(randomblob(16)))
WHERE id IN (SELECT workspace_id FROM panes WHERE kind = 'file-browser');
UPDATE panes SET kind = 'terminal' WHERE kind = 'file-browser';
