-- Explicitly accepted RDP certificates, shared across a user's windows/devices.
CREATE TABLE IF NOT EXISTS rdp_certificate_trust (
  user_id TEXT NOT NULL,
  target TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (
    length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, target)
);
