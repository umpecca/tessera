-- Retire only legacy Audio panes and invalidate clients holding their old layout.
UPDATE workspaces
SET active_pane_id = CASE
      WHEN active_pane_id IN (SELECT id FROM panes WHERE kind = 'audio')
      THEN COALESCE((SELECT id FROM panes
                     WHERE workspace_id = workspaces.id AND kind <> 'audio'
                     ORDER BY minimized, position LIMIT 1), '')
      ELSE active_pane_id END,
    layout_json = CASE WHEN json_valid(layout_json) THEN
      CASE WHEN json_type(layout_json, '$.panes') = 'array' THEN
        json_set(layout_json, '$.panes', json((
          SELECT json_group_array(value) FROM json_each(workspaces.layout_json, '$.panes')
          WHERE value NOT IN (SELECT id FROM panes WHERE kind = 'audio')
        )))
      ELSE layout_json END
      ELSE layout_json END,
    revision = lower(hex(randomblob(16)))
WHERE id IN (SELECT workspace_id FROM panes WHERE kind = 'audio');

DELETE FROM panes WHERE kind = 'audio';
DROP TABLE IF EXISTS audio_station;
