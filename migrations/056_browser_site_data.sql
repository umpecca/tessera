-- What pages in Browser panes keep, which they can't keep in the browser
-- (task 242): localStorage items and persistent cookies, per account and
-- development server origin.
CREATE TABLE IF NOT EXISTS browser_storage (
  account TEXT NOT NULL,
  origin TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (account, origin, key)
);

CREATE TABLE IF NOT EXISTS browser_cookies (
  account TEXT NOT NULL,
  origin TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  value TEXT NOT NULL,
  expires INTEGER NOT NULL,
  secure INTEGER NOT NULL,
  http_only INTEGER NOT NULL,
  same_site TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (account, origin, name, path)
);
