package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

const DefaultWorkspaceID = "default"

type Workspace struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	ActivePaneID string          `json:"activePaneId"`
	Layout       json.RawMessage `json:"layout"`
	Panes        []Pane          `json:"panes"`
}

type Pane struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	BufferText string `json:"bufferText"`
	Cwd        string `json:"cwd"`
	X          int    `json:"x"`
	Y          int    `json:"y"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	ZIndex     int    `json:"zIndex"`
	Position   int    `json:"position"`
}

func (s *Store) LoadDefaultWorkspace(ctx context.Context, defaultCwd string) (*Workspace, error) {
	ws, err := s.LoadWorkspace(ctx, DefaultWorkspaceID)
	if err == nil {
		return ws, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if defaultCwd == "" {
		defaultCwd, _ = os.Getwd()
	}

	ws = &Workspace{
		ID:           DefaultWorkspaceID,
		Name:         "Default",
		ActivePaneID: "",
		Layout:       json.RawMessage(`{"panes":[]}`),
		Panes:        []Pane{},
	}
	if err := s.SaveWorkspace(ctx, ws); err != nil {
		return nil, err
	}
	return ws, nil
}

func (s *Store) LoadWorkspace(ctx context.Context, id string) (*Workspace, error) {
	var ws Workspace
	var layoutText string
	err := s.db.QueryRowContext(ctx, `
SELECT id, name, active_pane_id, layout_json
FROM workspaces
WHERE id = ?`, id).Scan(&ws.ID, &ws.Name, &ws.ActivePaneID, &layoutText)
	if err != nil {
		return nil, err
	}
	if !json.Valid([]byte(layoutText)) {
		layoutText = "{}"
	}
	ws.Layout = json.RawMessage(layoutText)

	rows, err := s.db.QueryContext(ctx, `
SELECT id, title, buffer_text, cwd, x, y, width, height, z_index, position
FROM panes
WHERE workspace_id = ?
ORDER BY position ASC, created_at ASC`, id)
	if err != nil {
		return nil, fmt.Errorf("load panes: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var pane Pane
		if err := rows.Scan(&pane.ID, &pane.Title, &pane.BufferText, &pane.Cwd, &pane.X, &pane.Y, &pane.Width, &pane.Height, &pane.ZIndex, &pane.Position); err != nil {
			return nil, fmt.Errorf("scan pane: %w", err)
		}
		ws.Panes = append(ws.Panes, pane)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate panes: %w", err)
	}
	if ws.Panes == nil {
		ws.Panes = []Pane{}
	}
	return &ws, nil
}

func (s *Store) SaveWorkspace(ctx context.Context, ws *Workspace) error {
	if ws == nil {
		return errors.New("workspace is required")
	}
	if ws.ID == "" {
		ws.ID = DefaultWorkspaceID
	}
	if ws.Name == "" {
		ws.Name = "Default"
	}
	if len(ws.Layout) == 0 || !json.Valid(ws.Layout) {
		ws.Layout = json.RawMessage(`{"panes":[]}`)
	}
	if ws.ActivePaneID == "" && len(ws.Panes) > 0 {
		ws.ActivePaneID = ws.Panes[0].ID
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin save workspace: %w", err)
	}
	defer tx.Rollback()

	now := nowText()
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspaces (id, name, active_pane_id, layout_json, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  active_pane_id = excluded.active_pane_id,
  layout_json = excluded.layout_json,
  updated_at = excluded.updated_at`,
		ws.ID, ws.Name, ws.ActivePaneID, string(ws.Layout), now, now); err != nil {
		return fmt.Errorf("upsert workspace: %w", err)
	}

	seen := make(map[string]bool, len(ws.Panes))
	for i, pane := range ws.Panes {
		if pane.ID == "" {
			pane.ID = "pane-" + newID()
			ws.Panes[i].ID = pane.ID
		}
		if pane.Title == "" {
			pane.Title = fmt.Sprintf("Pane %d", i+1)
		}
		if pane.Width < 1 {
			pane.Width = 360
		}
		if pane.Height < 1 {
			pane.Height = 240
		}
		pane.Position = i
		seen[pane.ID] = true

		if _, err := tx.ExecContext(ctx, `
INSERT INTO panes (id, workspace_id, title, buffer_text, cwd, x, y, width, height, z_index, position, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title,
  buffer_text = excluded.buffer_text,
  cwd = excluded.cwd,
  x = excluded.x,
  y = excluded.y,
  width = excluded.width,
  height = excluded.height,
  z_index = excluded.z_index,
  position = excluded.position,
  updated_at = excluded.updated_at`,
			pane.ID, ws.ID, pane.Title, pane.BufferText, pane.Cwd, pane.X, pane.Y, pane.Width, pane.Height, pane.ZIndex, pane.Position, now, now); err != nil {
			return fmt.Errorf("upsert pane %s: %w", pane.ID, err)
		}
	}

	rows, err := tx.QueryContext(ctx, `SELECT id FROM panes WHERE workspace_id = ?`, ws.ID)
	if err != nil {
		return fmt.Errorf("list existing panes: %w", err)
	}
	var stale []string
	for rows.Next() {
		var paneID string
		if err := rows.Scan(&paneID); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan existing pane: %w", err)
		}
		if !seen[paneID] {
			stale = append(stale, paneID)
		}
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close pane rows: %w", err)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate existing panes: %w", err)
	}
	for _, paneID := range stale {
		if _, err := tx.ExecContext(ctx, `DELETE FROM panes WHERE id = ?`, paneID); err != nil {
			return fmt.Errorf("delete stale pane %s: %w", paneID, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace: %w", err)
	}
	return nil
}

func (s *Store) StartCommandRun(ctx context.Context, id, workspaceID, paneID, commandText, cwd string) error {
	if id == "" {
		return errors.New("command run id is required")
	}
	if workspaceID == "" {
		workspaceID = DefaultWorkspaceID
	}
	now := nowText()
	_, err := s.db.ExecContext(ctx, `
INSERT INTO command_runs (id, workspace_id, pane_id, command_text, cwd_before, started_at)
VALUES (?, ?, ?, ?, ?, ?)`, id, workspaceID, paneID, commandText, cwd, now)
	if err != nil {
		return fmt.Errorf("start command run: %w", err)
	}
	return nil
}

func (s *Store) FinishCommandRun(ctx context.Context, id, cwdAfter string, exitCode int) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE command_runs
SET cwd_after = ?, exit_code = ?, finished_at = ?
WHERE id = ?`, cwdAfter, exitCode, nowText(), id)
	if err != nil {
		return fmt.Errorf("finish command run: %w", err)
	}
	return nil
}

func NewID(prefix string) string {
	if prefix == "" {
		return newID()
	}
	return prefix + "-" + newID()
}

func newID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", os.Getpid())
	}
	return hex.EncodeToString(b[:])
}
