package store

import (
	"context"
	"errors"
	"fmt"
)

// WorkspaceBackground is a workspace's stored background image.
type WorkspaceBackground struct {
	MimeType  string
	Image     []byte
	UpdatedAt string
}

// LoadWorkspaceBackground returns the workspace's background image, or
// sql.ErrNoRows when none is set.
func (s *Store) LoadWorkspaceBackground(ctx context.Context, workspaceID string) (*WorkspaceBackground, error) {
	if workspaceID == "" {
		workspaceID = DefaultWorkspaceID
	}
	var bg WorkspaceBackground
	err := s.db.QueryRowContext(ctx, `
SELECT mime_type, image, updated_at
FROM workspace_backgrounds
WHERE workspace_id = ?`, workspaceID).Scan(&bg.MimeType, &bg.Image, &bg.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &bg, nil
}

// SaveWorkspaceBackground stores (or replaces) the workspace's background image
// and returns the new version stamp. The workspace row must already exist; the
// caller ensures this so the foreign key holds.
func (s *Store) SaveWorkspaceBackground(ctx context.Context, workspaceID, mimeType string, image []byte) (string, error) {
	if workspaceID == "" {
		workspaceID = DefaultWorkspaceID
	}
	if mimeType == "" {
		return "", errors.New("background mime type is required")
	}
	if len(image) == 0 {
		return "", errors.New("background image is empty")
	}
	now := nowText()
	_, err := s.db.ExecContext(ctx, `
INSERT INTO workspace_backgrounds (workspace_id, mime_type, image, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(workspace_id) DO UPDATE SET
  mime_type = excluded.mime_type,
  image = excluded.image,
  updated_at = excluded.updated_at`,
		workspaceID, mimeType, image, now)
	if err != nil {
		return "", fmt.Errorf("save workspace background: %w", err)
	}
	return now, nil
}

// DeleteWorkspaceBackground removes the workspace's background image. Removing a
// background that does not exist is not an error.
func (s *Store) DeleteWorkspaceBackground(ctx context.Context, workspaceID string) error {
	if workspaceID == "" {
		workspaceID = DefaultWorkspaceID
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM workspace_backgrounds WHERE workspace_id = ?`, workspaceID); err != nil {
		return fmt.Errorf("delete workspace background: %w", err)
	}
	return nil
}
