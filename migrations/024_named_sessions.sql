UPDATE workspaces
SET owner_id = id,
    name = 'Default',
    last_opened_at = CASE WHEN last_opened_at = '' THEN updated_at ELSE last_opened_at END
WHERE owner_id = '';

INSERT OR IGNORE INTO user_settings (
  user_id,
  default_pane_font_size,
  default_theme,
  theme_id,
  created_at,
  updated_at
)
SELECT
  owner_id,
  default_pane_font_size,
  default_theme,
  theme_id,
  created_at,
  updated_at
FROM workspaces;
