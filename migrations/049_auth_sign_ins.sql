CREATE TABLE IF NOT EXISTS auth_sign_ins (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  account TEXT NOT NULL,
  credential_tag TEXT NOT NULL DEFAULT '',
  remember INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  idle_seconds INTEGER NOT NULL,
  created_ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  last_ip TEXT NOT NULL DEFAULT '',
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS auth_sign_ins_account ON auth_sign_ins (account);
