CREATE TABLE IF NOT EXISTS pki_files (
  name TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
