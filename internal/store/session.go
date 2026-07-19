package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

var (
	ErrInvalidSessionName = errors.New("session name must be between 1 and 80 characters")
	ErrSessionNameExists  = errors.New("a session with that name already exists")
	ErrLastSession        = errors.New("the final session cannot be destroyed")
)

type Session struct {
	ID           string `json:"id"`
	UserID       string `json:"userId"`
	Name         string `json:"name"`
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
	LastOpenedAt string `json:"lastOpenedAt"`
}

type UserSettings struct {
	UserID                   string  `json:"userId"`
	DefaultPaneFontSize      int     `json:"defaultPaneFontSize"`
	DefaultTheme             string  `json:"defaultTheme"`
	ThemeID                  string  `json:"themeId"`
	DeskbarButtonEnabled     bool    `json:"deskbarButtonEnabled"`
	TerminalWheelSensitivity float64 `json:"terminalWheelSensitivity"`
	EditorWheelSensitivity   float64 `json:"editorWheelSensitivity"`
}

const defaultWheelSensitivity = 1.0

func normalizeWheelSensitivity(value float64) float64 {
	if value < 0.25 || value > 4 {
		return defaultWheelSensitivity
	}
	return value
}

func normalizeSessionName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 80 {
		return "", ErrInvalidSessionName
	}
	return name, nil
}

func (s *Store) EnsureUserDefaultSession(ctx context.Context, userID string) (*Session, error) {
	if userID == "" {
		userID = DefaultWorkspaceID
	}
	sessions, err := s.ListSessions(ctx, userID)
	if err != nil {
		return nil, err
	}
	if len(sessions) > 0 {
		return &sessions[0], nil
	}
	return s.CreateSession(ctx, userID, "Default")
}

func (s *Store) ListSessions(ctx context.Context, userID string) ([]Session, error) {
	if userID == "" {
		userID = DefaultWorkspaceID
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT id, owner_id, name, created_at, updated_at, last_opened_at
FROM workspaces
WHERE owner_id = ?
ORDER BY last_opened_at DESC, created_at ASC`, userID)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	defer rows.Close()

	sessions := []Session{}
	for rows.Next() {
		var session Session
		if err := rows.Scan(&session.ID, &session.UserID, &session.Name, &session.CreatedAt, &session.UpdatedAt, &session.LastOpenedAt); err != nil {
			return nil, fmt.Errorf("scan session: %w", err)
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate sessions: %w", err)
	}
	return sessions, nil
}

func (s *Store) CreateSession(ctx context.Context, userID, name string) (*Session, error) {
	if userID == "" {
		userID = DefaultWorkspaceID
	}
	name, err := normalizeSessionName(name)
	if err != nil {
		return nil, err
	}
	var exists int
	err = s.db.QueryRowContext(ctx, `SELECT 1 FROM workspaces WHERE owner_id = ? AND name = ? COLLATE NOCASE`, userID, name).Scan(&exists)
	if err == nil {
		return nil, ErrSessionNameExists
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("check session name: %w", err)
	}

	settings, err := s.LoadUserSettings(ctx, userID)
	if err != nil {
		return nil, err
	}

	// New sessions start with the same wallpaper as the user's most recently
	// used session, the same way they already inherit the font size and
	// theme, so switching to a fresh session doesn't lose the background.
	var sourceSessionID string
	var sourceBackgroundMode string
	if existing, err := s.ListSessions(ctx, userID); err == nil && len(existing) > 0 {
		sourceSessionID = existing[0].ID
		sourceBackgroundMode, _ = s.workspaceBackgroundMode(ctx, sourceSessionID)
	}

	now := nowText()
	ws := &Workspace{
		ID:                  NewID("session"),
		OwnerID:             userID,
		Name:                name,
		Layout:              []byte(`{"panes":[]}`),
		Panes:               []Pane{},
		BackgroundMode:      "fill",
		DefaultPaneFontSize: settings.DefaultPaneFontSize,
		DefaultTheme:        settings.DefaultTheme,
		ThemeID:             settings.ThemeID,
		LastOpenedAt:        now,
	}
	if sourceBackgroundMode != "" {
		ws.BackgroundMode = sourceBackgroundMode
	}
	if err := s.SaveWorkspace(ctx, ws); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique constraint") {
			return nil, ErrSessionNameExists
		}
		return nil, err
	}
	if sourceSessionID != "" {
		if bg, err := s.LoadWorkspaceBackground(ctx, sourceSessionID); err == nil {
			if _, err := s.SaveWorkspaceBackground(ctx, ws.ID, bg.MimeType, bg.Image); err != nil {
				return nil, fmt.Errorf("copy session background: %w", err)
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("load source session background: %w", err)
		}
	}
	return &Session{ID: ws.ID, UserID: userID, Name: name, CreatedAt: now, UpdatedAt: now, LastOpenedAt: now}, nil
}

func (s *Store) workspaceBackgroundMode(ctx context.Context, workspaceID string) (string, error) {
	var mode string
	err := s.db.QueryRowContext(ctx, `SELECT background_mode FROM workspaces WHERE id = ?`, workspaceID).Scan(&mode)
	if err != nil {
		return "", err
	}
	return normalizeBackgroundMode(mode), nil
}

func (s *Store) RenameSession(ctx context.Context, userID, sessionID, name string) (*Session, error) {
	name, err := normalizeSessionName(name)
	if err != nil {
		return nil, err
	}
	var exists int
	err = s.db.QueryRowContext(ctx, `SELECT 1 FROM workspaces WHERE owner_id = ? AND id <> ? AND name = ? COLLATE NOCASE`, userID, sessionID, name).Scan(&exists)
	if err == nil {
		return nil, ErrSessionNameExists
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("check session name: %w", err)
	}
	now := nowText()
	result, err := s.db.ExecContext(ctx, `UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ? AND owner_id = ?`, name, now, sessionID, userID)
	if err != nil {
		return nil, fmt.Errorf("rename session: %w", err)
	}
	if rows, _ := result.RowsAffected(); rows == 0 {
		return nil, sql.ErrNoRows
	}
	return s.Session(ctx, userID, sessionID)
}

func (s *Store) ActivateSession(ctx context.Context, userID, sessionID string) error {
	result, err := s.db.ExecContext(ctx, `UPDATE workspaces SET last_opened_at = ? WHERE id = ? AND owner_id = ?`, nowText(), sessionID, userID)
	if err != nil {
		return fmt.Errorf("activate session: %w", err)
	}
	if rows, _ := result.RowsAffected(); rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) Session(ctx context.Context, userID, sessionID string) (*Session, error) {
	var session Session
	err := s.db.QueryRowContext(ctx, `
SELECT id, owner_id, name, created_at, updated_at, last_opened_at
FROM workspaces
WHERE id = ? AND owner_id = ?`, sessionID, userID).Scan(
		&session.ID, &session.UserID, &session.Name, &session.CreatedAt, &session.UpdatedAt, &session.LastOpenedAt)
	if err != nil {
		return nil, err
	}
	return &session, nil
}

func (s *Store) SessionOwner(ctx context.Context, sessionID string) (string, error) {
	var ownerID string
	if err := s.db.QueryRowContext(ctx, `SELECT owner_id FROM workspaces WHERE id = ?`, sessionID).Scan(&ownerID); err != nil {
		return "", err
	}
	return ownerID, nil
}

func (s *Store) DeleteSession(ctx context.Context, userID, sessionID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin delete session: %w", err)
	}
	defer tx.Rollback()

	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspaces WHERE owner_id = ?`, userID).Scan(&count); err != nil {
		return fmt.Errorf("count sessions: %w", err)
	}
	if count <= 1 {
		return ErrLastSession
	}
	result, err := tx.ExecContext(ctx, `DELETE FROM workspaces WHERE id = ? AND owner_id = ?`, sessionID, userID)
	if err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	if rows, _ := result.RowsAffected(); rows == 0 {
		return sql.ErrNoRows
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete session: %w", err)
	}
	return nil
}

func (s *Store) LoadUserSettings(ctx context.Context, userID string) (*UserSettings, error) {
	if userID == "" {
		userID = DefaultWorkspaceID
	}
	var settings UserSettings
	err := s.db.QueryRowContext(ctx, `
SELECT user_id, default_pane_font_size, default_theme, theme_id, deskbar_button_enabled,
       terminal_wheel_sensitivity, editor_wheel_sensitivity
FROM user_settings
WHERE user_id = ?`, userID).Scan(
		&settings.UserID, &settings.DefaultPaneFontSize, &settings.DefaultTheme,
		&settings.ThemeID, &settings.DeskbarButtonEnabled,
		&settings.TerminalWheelSensitivity, &settings.EditorWheelSensitivity)
	if errors.Is(err, sql.ErrNoRows) {
		now := nowText()
		if _, err := s.db.ExecContext(ctx, `
INSERT OR IGNORE INTO user_settings (
  user_id, default_pane_font_size, default_theme, theme_id,
  deskbar_button_enabled, terminal_wheel_sensitivity,
  editor_wheel_sensitivity, created_at, updated_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, userID, defaultPaneFontSize, defaultThemeID, defaultThemeID, true, defaultWheelSensitivity, defaultWheelSensitivity, now, now); err != nil {
			return nil, fmt.Errorf("create user settings: %w", err)
		}
		return s.LoadUserSettings(ctx, userID)
	}
	if err != nil {
		return nil, fmt.Errorf("load user settings: %w", err)
	}
	settings.DefaultPaneFontSize = normalizeDefaultPaneFontSize(settings.DefaultPaneFontSize)
	settings.DefaultTheme = normalizeThemeID(settings.DefaultTheme)
	settings.ThemeID = normalizeThemeID(settings.ThemeID)
	settings.TerminalWheelSensitivity = normalizeWheelSensitivity(settings.TerminalWheelSensitivity)
	settings.EditorWheelSensitivity = normalizeWheelSensitivity(settings.EditorWheelSensitivity)
	return &settings, nil
}

func (s *Store) SaveUserSettings(ctx context.Context, settings *UserSettings) error {
	if settings == nil {
		return errors.New("user settings are required")
	}
	if settings.UserID == "" {
		settings.UserID = DefaultWorkspaceID
	}
	settings.DefaultPaneFontSize = normalizeDefaultPaneFontSize(settings.DefaultPaneFontSize)
	settings.DefaultTheme = normalizeThemeID(settings.DefaultTheme)
	settings.ThemeID = normalizeThemeID(settings.ThemeID)
	settings.TerminalWheelSensitivity = normalizeWheelSensitivity(settings.TerminalWheelSensitivity)
	settings.EditorWheelSensitivity = normalizeWheelSensitivity(settings.EditorWheelSensitivity)
	now := nowText()
	_, err := s.db.ExecContext(ctx, `
INSERT INTO user_settings (
  user_id, default_pane_font_size, default_theme, theme_id,
  deskbar_button_enabled, terminal_wheel_sensitivity,
  editor_wheel_sensitivity, created_at, updated_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(user_id) DO UPDATE SET
  default_pane_font_size = excluded.default_pane_font_size,
  default_theme = excluded.default_theme,
  theme_id = excluded.theme_id,
  deskbar_button_enabled = excluded.deskbar_button_enabled,
  terminal_wheel_sensitivity = excluded.terminal_wheel_sensitivity,
  editor_wheel_sensitivity = excluded.editor_wheel_sensitivity,
  updated_at = excluded.updated_at`, settings.UserID, settings.DefaultPaneFontSize,
		settings.DefaultTheme, settings.ThemeID, settings.DeskbarButtonEnabled,
		settings.TerminalWheelSensitivity, settings.EditorWheelSensitivity, now, now)
	if err != nil {
		return fmt.Errorf("save user settings: %w", err)
	}
	return nil
}
