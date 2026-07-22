UPDATE workspaces
SET revision = lower(hex(randomblob(16)))
WHERE revision = '';
