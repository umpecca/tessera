package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"tessera/internal/shortcuts"
)

var ErrShortcutsConflict = errors.New("shortcuts changed in another browser; reload before saving")

type Shortcuts struct {
	Revision  string               `json:"revision"`
	Shortcuts []shortcuts.Shortcut `json:"shortcuts"`
}

func (s *Store) LoadShortcuts(ctx context.Context, userID string) (*Shortcuts, error) {
	if userID == "" {
		userID = DefaultWorkspaceID
	}
	if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO user_shortcuts (user_id,revision,shortcuts_json,updated_at) VALUES (?,?,'[]',?)`, userID, newID(), nowText()); err != nil {
		return nil, err
	}
	var result Shortcuts
	var raw string
	if err := s.db.QueryRowContext(ctx, `SELECT revision,shortcuts_json FROM user_shortcuts WHERE user_id=?`, userID).Scan(&result.Revision, &raw); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(raw), &result.Shortcuts); err != nil {
		return nil, fmt.Errorf("load shortcuts: %w", err)
	}
	return &result, nil
}

func (s *Store) SaveShortcuts(ctx context.Context, userID string, doc *Shortcuts) error {
	if doc == nil {
		return errors.New("shortcuts are required")
	}
	if err := shortcuts.Validate(doc.Shortcuts); err != nil {
		return err
	}
	if userID == "" {
		userID = DefaultWorkspaceID
	}
	if doc.Shortcuts == nil {
		doc.Shortcuts = []shortcuts.Shortcut{}
	}
	raw, err := json.Marshal(doc.Shortcuts)
	if err != nil {
		return err
	}
	revision := newID()
	result, err := s.db.ExecContext(ctx, `UPDATE user_shortcuts SET revision=?,shortcuts_json=?,updated_at=? WHERE user_id=? AND revision=?`, revision, string(raw), nowText(), userID, doc.Revision)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrShortcutsConflict
	}
	doc.Revision = revision
	return nil
}
