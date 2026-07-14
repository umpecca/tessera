CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  default_pane_font_size INTEGER NOT NULL DEFAULT 14,
  default_theme TEXT NOT NULL DEFAULT 'next-tessera',
  theme_id TEXT NOT NULL DEFAULT 'next-tessera',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
