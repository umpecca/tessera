package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

var ErrSnippetsConflict = errors.New("snippets changed in another browser; reload before saving")

// Snippets are text a person keeps to send to terminals from a phone: a
// command, or a prompt for a program such as Claude Code. They belong to the
// account, so every device has them, and are saved with their own revision,
// so a page that knows nothing of them never overwrites them.
type Snippets struct {
	Revision string    `json:"revision"`
	Snippets []Snippet `json:"snippets"`
}

type Snippet struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Text  string `json:"text"`
}

const maximumSnippets = 200
const maximumSnippetLabel = 80
const maximumSnippetText = 16 * 1024

func validateSnippets(snippets []Snippet) error {
	if len(snippets) > maximumSnippets {
		return fmt.Errorf("at most %d snippets", maximumSnippets)
	}
	ids := map[string]bool{}
	for _, snippet := range snippets {
		if snippet.ID == "" || len(snippet.ID) > 64 || ids[snippet.ID] {
			return errors.New("each snippet needs its own id")
		}
		ids[snippet.ID] = true
		if strings.TrimSpace(snippet.Text) == "" {
			return errors.New("a snippet needs text")
		}
		if !utf8.ValidString(snippet.Label) || !utf8.ValidString(snippet.Text) {
			return errors.New("snippets must be UTF-8 text")
		}
		if utf8.RuneCountInString(snippet.Label) > maximumSnippetLabel {
			return fmt.Errorf("a snippet's name can be at most %d characters", maximumSnippetLabel)
		}
		if len(snippet.Text) > maximumSnippetText {
			return fmt.Errorf("a snippet can be at most %d KiB", maximumSnippetText/1024)
		}
	}
	return nil
}

func (s *Store) LoadSnippets(ctx context.Context, userID string) (*Snippets, error) {
	if userID == "" {
		userID = DefaultWorkspaceID
	}
	if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO user_snippets (user_id,revision,snippets_json,updated_at) VALUES (?,?,'[]',?)`, userID, newID(), nowText()); err != nil {
		return nil, err
	}
	var result Snippets
	var raw string
	if err := s.db.QueryRowContext(ctx, `SELECT revision,snippets_json FROM user_snippets WHERE user_id=?`, userID).Scan(&result.Revision, &raw); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(raw), &result.Snippets); err != nil {
		return nil, fmt.Errorf("load snippets: %w", err)
	}
	return &result, nil
}

// SaveSnippets replaces the account's snippets if doc.Revision is still
// current, and gives doc the new revision.
func (s *Store) SaveSnippets(ctx context.Context, userID string, doc *Snippets) error {
	if doc == nil {
		return errors.New("snippets are required")
	}
	if err := validateSnippets(doc.Snippets); err != nil {
		return err
	}
	if userID == "" {
		userID = DefaultWorkspaceID
	}
	if doc.Snippets == nil {
		doc.Snippets = []Snippet{}
	}
	raw, err := json.Marshal(doc.Snippets)
	if err != nil {
		return err
	}
	if _, err := s.LoadSnippets(ctx, userID); err != nil {
		return err
	}
	revision := newID()
	result, err := s.db.ExecContext(ctx, `UPDATE user_snippets SET revision=?,snippets_json=?,updated_at=? WHERE user_id=? AND revision=?`, revision, string(raw), nowText(), userID, doc.Revision)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrSnippetsConflict
	}
	doc.Revision = revision
	return nil
}
