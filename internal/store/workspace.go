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

var ErrWorkspaceConflict = errors.New("workspace has changed since it was loaded")

type Workspace struct {
	ID       string `json:"id"`
	Revision string `json:"revision"`
	// Client-generated tokens let a final save supersede its own in-flight
	// request without accepting revisions written by another browser.
	NextRevision      string          `json:"nextRevision,omitempty"`
	AlternateRevision string          `json:"alternateRevision,omitempty"`
	OwnerID           string          `json:"ownerId,omitempty"`
	Name              string          `json:"name"`
	ActivePaneID      string          `json:"activePaneId"`
	Layout            json.RawMessage `json:"layout"`
	Panes             []Pane          `json:"panes"`
	// HasBackground and BackgroundVersion describe the workspace's background
	// image. They are populated on load (the image bytes live in a separate
	// table, served on demand) and ignored on save.
	HasBackground       bool   `json:"hasBackground"`
	BackgroundVersion   string `json:"backgroundVersion,omitempty"`
	BackgroundMode      string `json:"backgroundMode"`
	DefaultPaneFontSize int    `json:"defaultPaneFontSize"`
	DefaultTheme        string `json:"defaultTheme"`
	ThemeID             string `json:"themeId"`
	LastOpenedAt        string `json:"lastOpenedAt,omitempty"`
}

// Legacy document fields remain opaque archive data for workspace exports.
// No active pane renders or executes BufferText or EditorTabs.
type Pane struct {
	ID             string `json:"id"`
	Kind           string `json:"kind"`
	Title          string `json:"title"`
	BufferText     string `json:"bufferText"`
	EditorMode     string `json:"editorMode"`
	FontSize       int    `json:"fontSize"`
	Cwd            string `json:"cwd"`
	LastExportPath string `json:"lastExportPath"`
	EditorTabs     string `json:"editorTabs"`
	BrowserURL     string `json:"browserUrl"`
	VNCTarget      string `json:"vncTarget"`
	VNCViewOnly    bool   `json:"vncViewOnly"`
	VNCScaleMode   string `json:"vncScaleMode"`
	IsFull         bool   `json:"isFull"`
	RestoreBox     string `json:"restoreBox"`
	Minimized      bool   `json:"minimized"`
	X              int    `json:"x"`
	Y              int    `json:"y"`
	Width          int    `json:"width"`
	Height         int    `json:"height"`
	ZIndex         int    `json:"zIndex"`
	Position       int    `json:"position"`
	// BufferTextUnchanged and EditorTabsUnchanged let a save skip resending a
	// pane's documents: the stored copy is kept and BufferText/EditorTabs above
	// are ignored. They are request-only, so a loaded workspace never sets them.
	BufferTextUnchanged bool `json:"bufferTextUnchanged,omitempty"`
	EditorTabsUnchanged bool `json:"editorTabsUnchanged,omitempty"`
}

type paneVNCSettings struct {
	Target    string `json:"target,omitempty"`
	ViewOnly  bool   `json:"viewOnly,omitempty"`
	ScaleMode string `json:"scaleMode,omitempty"`
}

func paneVNCSettingsJSON(pane Pane) string {
	settings, _ := json.Marshal(paneVNCSettings{Target: pane.VNCTarget, ViewOnly: pane.VNCViewOnly, ScaleMode: pane.VNCScaleMode})
	return string(settings)
}

func applyPaneVNCSettings(pane *Pane, raw string) {
	var settings paneVNCSettings
	_ = json.Unmarshal([]byte(raw), &settings)
	pane.VNCTarget = settings.Target
	pane.VNCViewOnly = settings.ViewOnly
	pane.VNCScaleMode = settings.ScaleMode
}

func (s *Store) LoadDefaultWorkspace(ctx context.Context, defaultCwd string) (*Workspace, error) {
	return s.LoadOrCreateWorkspace(ctx, DefaultWorkspaceID, "Default")
}

// LoadOrCreateWorkspace returns the workspace with the given id, creating an
// empty one (named name, or the id when name is blank) if it does not exist.
// It backs both the single default workspace and per-user workspaces.
func (s *Store) LoadOrCreateWorkspace(ctx context.Context, id, name string) (*Workspace, error) {
	if id == "" {
		id = DefaultWorkspaceID
	}
	ws, err := s.LoadWorkspace(ctx, id)
	if err == nil {
		return ws, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if name == "" {
		name = id
	}

	ws = &Workspace{
		ID:                  id,
		OwnerID:             id,
		Name:                name,
		ActivePaneID:        "",
		Layout:              json.RawMessage(`{"panes":[]}`),
		Panes:               []Pane{},
		DefaultPaneFontSize: defaultPaneFontSize,
		DefaultTheme:        defaultThemeID,
		ThemeID:             defaultThemeID,
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
	SELECT id, revision, owner_id, name, active_pane_id, layout_json, background_mode, default_pane_font_size, default_theme, theme_id, last_opened_at
FROM workspaces
WHERE id = ?`, id).Scan(&ws.ID, &ws.Revision, &ws.OwnerID, &ws.Name, &ws.ActivePaneID, &layoutText, &ws.BackgroundMode, &ws.DefaultPaneFontSize, &ws.DefaultTheme, &ws.ThemeID, &ws.LastOpenedAt)
	if err != nil {
		return nil, err
	}
	if !json.Valid([]byte(layoutText)) {
		layoutText = "{}"
	}
	ws.Layout = json.RawMessage(layoutText)
	ws.BackgroundMode = normalizeBackgroundMode(ws.BackgroundMode)
	ws.DefaultPaneFontSize = normalizeDefaultPaneFontSize(ws.DefaultPaneFontSize)
	ws.DefaultTheme = normalizeThemeID(ws.DefaultTheme)
	ws.ThemeID = normalizeThemeID(ws.ThemeID)

	rows, err := s.db.QueryContext(ctx, `
SELECT id, kind, title, buffer_text, editor_mode, font_size, cwd, last_export_path, editor_tabs, browser_url, vnc_settings, is_full, restore_box, minimized, x, y, width, height, z_index, position
FROM panes
WHERE workspace_id = ?
ORDER BY position ASC, created_at ASC`, id)
	if err != nil {
		return nil, fmt.Errorf("load panes: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var pane Pane
		var vncSettings string
		if err := rows.Scan(&pane.ID, &pane.Kind, &pane.Title, &pane.BufferText, &pane.EditorMode, &pane.FontSize, &pane.Cwd, &pane.LastExportPath, &pane.EditorTabs, &pane.BrowserURL, &vncSettings, &pane.IsFull, &pane.RestoreBox, &pane.Minimized, &pane.X, &pane.Y, &pane.Width, &pane.Height, &pane.ZIndex, &pane.Position); err != nil {
			return nil, fmt.Errorf("scan pane: %w", err)
		}
		applyPaneVNCSettings(&pane, vncSettings)
		if pane.Kind == "" {
			pane.Kind = "terminal"
		}
		if pane.VNCScaleMode != "one-to-one" {
			pane.VNCScaleMode = "fit"
		}
		ws.Panes = append(ws.Panes, pane)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate panes: %w", err)
	}
	if ws.Panes == nil {
		ws.Panes = []Pane{}
	}

	var backgroundUpdatedAt string
	err = s.db.QueryRowContext(ctx, `SELECT updated_at FROM workspace_backgrounds WHERE workspace_id = ?`, id).Scan(&backgroundUpdatedAt)
	switch {
	case err == nil:
		ws.HasBackground = true
		ws.BackgroundVersion = backgroundUpdatedAt
	case errors.Is(err, sql.ErrNoRows):
		// no background configured
	default:
		return nil, fmt.Errorf("load background meta: %w", err)
	}

	return &ws, nil
}

func (s *Store) LoadPane(ctx context.Context, workspaceID, paneID string) (*Pane, error) {
	if workspaceID == "" {
		workspaceID = DefaultWorkspaceID
	}
	if paneID == "" {
		return nil, errors.New("pane id is required")
	}
	var pane Pane
	var vncSettings string
	err := s.db.QueryRowContext(ctx, `
SELECT id, kind, title, buffer_text, editor_mode, font_size, cwd, last_export_path, editor_tabs, browser_url, vnc_settings, is_full, restore_box, minimized, x, y, width, height, z_index, position
FROM panes
WHERE workspace_id = ? AND id = ?`, workspaceID, paneID).Scan(
		&pane.ID, &pane.Kind, &pane.Title, &pane.BufferText, &pane.EditorMode, &pane.FontSize, &pane.Cwd, &pane.LastExportPath, &pane.EditorTabs, &pane.BrowserURL, &vncSettings, &pane.IsFull, &pane.RestoreBox, &pane.Minimized, &pane.X, &pane.Y, &pane.Width, &pane.Height, &pane.ZIndex, &pane.Position)
	if err != nil {
		return nil, err
	}
	applyPaneVNCSettings(&pane, vncSettings)
	if pane.Kind == "" {
		pane.Kind = "terminal"
	}
	if pane.VNCScaleMode != "one-to-one" {
		pane.VNCScaleMode = "fit"
	}
	return &pane, nil
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
	if ws.OwnerID == "" {
		ws.OwnerID = ws.ID
	}
	if len(ws.Layout) == 0 || !json.Valid(ws.Layout) {
		ws.Layout = json.RawMessage(`{"panes":[]}`)
	}
	ws.BackgroundMode = normalizeBackgroundMode(ws.BackgroundMode)
	ws.DefaultPaneFontSize = normalizeDefaultPaneFontSize(ws.DefaultPaneFontSize)
	ws.DefaultTheme = normalizeThemeID(ws.DefaultTheme)
	ws.ThemeID = normalizeThemeID(ws.ThemeID)
	// Old clients and imported documents can still contain the retired pane kind.
	// Discard Audio panes, which carry no editor documents.
	panes := make([]Pane, 0, len(ws.Panes))
	removedAudio := make(map[string]bool)
	for _, pane := range ws.Panes {
		if pane.Kind == "file-browser" || pane.Kind == "worksheet" || pane.Kind == "text-editor" {
			pane.Kind = "terminal"
		}
		if pane.Kind == "audio" {
			removedAudio[pane.ID] = true
			if ws.ActivePaneID == pane.ID {
				ws.ActivePaneID = ""
			}
			continue
		}
		panes = append(panes, pane)
	}
	ws.Panes = panes
	if len(removedAudio) > 0 {
		var layout map[string]json.RawMessage
		var paneIDs []string
		if json.Unmarshal(ws.Layout, &layout) == nil && json.Unmarshal(layout["panes"], &paneIDs) == nil {
			keptIDs := make([]string, 0, len(paneIDs))
			for _, id := range paneIDs {
				if !removedAudio[id] {
					keptIDs = append(keptIDs, id)
				}
			}
			layout["panes"], _ = json.Marshal(keptIDs)
			ws.Layout, _ = json.Marshal(layout)
		}
	}
	if ws.ActivePaneID == "" {
		for _, pane := range ws.Panes {
			if !pane.Minimized {
				ws.ActivePaneID = pane.ID
				break
			}
		}
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin save workspace: %w", err)
	}
	defer tx.Rollback()

	now := nowText()
	nextRevision := ws.NextRevision
	if nextRevision == "" {
		nextRevision = newID()
	} else if decoded, err := hex.DecodeString(nextRevision); err != nil || len(decoded) != 16 || nextRevision == ws.Revision || nextRevision == ws.AlternateRevision {
		return errors.New("invalid next workspace revision")
	}
	if ws.AlternateRevision != "" {
		if decoded, err := hex.DecodeString(ws.AlternateRevision); err != nil || len(decoded) != 16 || ws.Revision == "" {
			return errors.New("invalid alternate workspace revision")
		}
	}
	if ws.LastOpenedAt == "" {
		ws.LastOpenedAt = now
	}
	if ws.Revision == "" {
		result, err := tx.ExecContext(ctx, `
INSERT OR IGNORE INTO workspaces (id, revision, owner_id, name, active_pane_id, layout_json, background_mode, default_pane_font_size, default_theme, theme_id, last_opened_at, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			ws.ID, nextRevision, ws.OwnerID, ws.Name, ws.ActivePaneID, string(ws.Layout), ws.BackgroundMode, ws.DefaultPaneFontSize, ws.DefaultTheme, ws.ThemeID, ws.LastOpenedAt, now, now)
		if err != nil {
			return fmt.Errorf("insert workspace: %w", err)
		}
		inserted, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("check workspace insert: %w", err)
		}
		if inserted == 0 {
			return ErrWorkspaceConflict
		}
	} else {
		result, err := tx.ExecContext(ctx, `
UPDATE workspaces SET
  active_pane_id = ?,
  layout_json = ?,
  background_mode = ?,
  default_pane_font_size = ?,
  default_theme = ?,
  theme_id = ?,
  revision = ?,
  updated_at = ?
WHERE id = ? AND (revision = ? OR (revision = ? AND ? <> ''))`,
			ws.ActivePaneID, string(ws.Layout), ws.BackgroundMode, ws.DefaultPaneFontSize, ws.DefaultTheme, ws.ThemeID, nextRevision, now, ws.ID, ws.Revision, ws.AlternateRevision, ws.AlternateRevision)
		if err != nil {
			return fmt.Errorf("update workspace: %w", err)
		}
		updated, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("check workspace update: %w", err)
		}
		if updated == 0 {
			return ErrWorkspaceConflict
		}
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
		if pane.Kind == "" {
			pane.Kind = "terminal"
		}
		if pane.VNCScaleMode != "one-to-one" {
			pane.VNCScaleMode = "fit"
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
INSERT INTO panes (id, workspace_id, kind, title, buffer_text, editor_mode, font_size, cwd, last_export_path, editor_tabs, browser_url, vnc_settings, is_full, restore_box, minimized, x, y, width, height, z_index, position, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  kind = excluded.kind,
  title = excluded.title,
  buffer_text = CASE WHEN ? THEN panes.buffer_text ELSE excluded.buffer_text END,
  editor_mode = excluded.editor_mode,
  font_size = excluded.font_size,
  cwd = excluded.cwd,
  last_export_path = excluded.last_export_path,
  editor_tabs = CASE WHEN ? THEN panes.editor_tabs ELSE excluded.editor_tabs END,
  browser_url = excluded.browser_url,
  vnc_settings = excluded.vnc_settings,
  is_full = excluded.is_full,
  restore_box = excluded.restore_box,
  minimized = excluded.minimized,
  x = excluded.x,
  y = excluded.y,
  width = excluded.width,
  height = excluded.height,
  z_index = excluded.z_index,
  position = excluded.position,
  updated_at = excluded.updated_at`,
			pane.ID, ws.ID, pane.Kind, pane.Title, pane.BufferText, pane.EditorMode, pane.FontSize, pane.Cwd, pane.LastExportPath, pane.EditorTabs, pane.BrowserURL, paneVNCSettingsJSON(pane), pane.IsFull, pane.RestoreBox, pane.Minimized, pane.X, pane.Y, pane.Width, pane.Height, pane.ZIndex, pane.Position, now, now,
			pane.BufferTextUnchanged, pane.EditorTabsUnchanged); err != nil {
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
	ws.Revision = nextRevision
	ws.NextRevision = ""
	ws.AlternateRevision = ""
	return nil
}

func normalizeBackgroundMode(mode string) string {
	switch mode {
	case "fit", "stretch", "center":
		return mode
	default:
		return "fill"
	}
}

const (
	defaultPaneFontSize = 14
	minimumPaneFontSize = 10
	maximumPaneFontSize = 24
	defaultThemeID      = "next-tessera"
)

func normalizeDefaultPaneFontSize(fontSize int) int {
	if fontSize < minimumPaneFontSize || fontSize > maximumPaneFontSize {
		return defaultPaneFontSize
	}
	return fontSize
}

func normalizeThemeID(themeID string) string {
	if themeID == "" {
		return defaultThemeID
	}
	return themeID
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
