package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

func TestSessionCRUDAndUserSettings(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	first, err := st.EnsureUserDefaultSession(ctx, "alice")
	if err != nil {
		t.Fatalf("ensure default session: %v", err)
	}
	if first.Name != "Default" || first.UserID != "alice" {
		t.Fatalf("default session = %+v", first)
	}
	second, err := st.CreateSession(ctx, "alice", "  Project  ")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if second.Name != "Project" || second.ID == first.ID {
		t.Fatalf("created session = %+v", second)
	}
	if _, err := st.CreateSession(ctx, "alice", "project"); !errors.Is(err, ErrSessionNameExists) {
		t.Fatalf("duplicate name error = %v", err)
	}
	if _, err := st.CreateSession(ctx, "alice", "   "); !errors.Is(err, ErrInvalidSessionName) {
		t.Fatalf("blank name error = %v", err)
	}

	renamed, err := st.RenameSession(ctx, "alice", second.ID, "Work")
	if err != nil || renamed.Name != "Work" {
		t.Fatalf("rename session = %+v, %v", renamed, err)
	}
	if err := st.ActivateSession(ctx, "alice", first.ID); err != nil {
		t.Fatalf("activate session: %v", err)
	}
	if err := st.DeleteSession(ctx, "alice", second.ID); err != nil {
		t.Fatalf("delete session: %v", err)
	}
	if err := st.DeleteSession(ctx, "alice", first.ID); !errors.Is(err, ErrLastSession) {
		t.Fatalf("delete final session error = %v", err)
	}
	if _, err := st.Session(ctx, "alice", second.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("deleted session lookup error = %v", err)
	}

	settings := &UserSettings{
		UserID: "alice", DefaultPaneFontSize: 18, DefaultTheme: "studio",
		ThemeID: "hacker", DeskbarButtonEnabled: false,
		TerminalWheelSensitivity: 0.5, EditorWheelSensitivity: 2,
		OLEDWindowBorderSize: 16, TerminalTERM: "xterm-ghostty", TerminalFont: "fira-code",
		TerminalColorMode: "light",
	}
	if err := st.SaveUserSettings(ctx, settings); err != nil {
		t.Fatalf("save settings: %v", err)
	}
	loaded, err := st.LoadUserSettings(ctx, "alice")
	if err != nil {
		t.Fatalf("load settings: %v", err)
	}
	if loaded.DefaultPaneFontSize != 18 || loaded.DefaultTheme != "studio" || loaded.ThemeID != "hacker" || loaded.DeskbarButtonEnabled ||
		loaded.TerminalWheelSensitivity != 0.5 || loaded.EditorWheelSensitivity != 2 || loaded.OLEDWindowBorderSize != 16 || loaded.TerminalTERM != "xterm-ghostty" || loaded.TerminalFont != "fira-code" || loaded.TerminalColorMode != "light" {
		t.Fatalf("loaded settings = %+v", loaded)
	}
}

func TestTerminalFontNormalization(t *testing.T) {
	if got := NormalizeTerminalFont("fira-code"); got != "fira-code" {
		t.Fatalf("NormalizeTerminalFont(fira-code) = %q", got)
	}
	for _, value := range []string{"", "JetBrains Mono", "url(evil)"} {
		if got := NormalizeTerminalFont(value); got != DefaultTerminalFont {
			t.Errorf("NormalizeTerminalFont(%q) = %q, want %q", value, got, DefaultTerminalFont)
		}
	}
}

func TestTerminalColorModeNormalization(t *testing.T) {
	if got := NormalizeTerminalColorMode("light"); got != "light" {
		t.Fatalf("NormalizeTerminalColorMode(light) = %q", got)
	}
	for _, value := range []string{"", "system", "Light", "dark;drop"} {
		if got := NormalizeTerminalColorMode(value); got != DefaultTerminalColorMode {
			t.Errorf("NormalizeTerminalColorMode(%q) = %q, want %q", value, got, DefaultTerminalColorMode)
		}
	}
}

func TestTerminalTERMNormalization(t *testing.T) {
	for _, test := range []struct {
		value string
		want  string
	}{
		{value: " xterm-ghostty ", want: "xterm-ghostty"},
		{value: "screen_256color+custom", want: "screen_256color+custom"},
		{value: "", want: DefaultTerminalTERM},
		{value: "-xterm", want: DefaultTerminalTERM},
		{value: "xterm;echo nope", want: DefaultTerminalTERM},
	} {
		if got := NormalizeTerminalTERM(test.value); got != test.want {
			t.Errorf("NormalizeTerminalTERM(%q) = %q, want %q", test.value, got, test.want)
		}
	}
}

func TestNewUserWheelSensitivityDefaults(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	settings, err := st.LoadUserSettings(ctx, "alice")
	if err != nil {
		t.Fatalf("load settings: %v", err)
	}
	if settings.TerminalWheelSensitivity != 1.5 || settings.EditorWheelSensitivity != 1.5 {
		t.Fatalf("new user wheel sensitivity = terminal %v, editor %v", settings.TerminalWheelSensitivity, settings.EditorWheelSensitivity)
	}
}

func TestCreateSessionInheritsBackgroundFromMostRecentSession(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	first, err := st.EnsureUserDefaultSession(ctx, "alice")
	if err != nil {
		t.Fatalf("ensure default session: %v", err)
	}
	if _, err := st.SaveWorkspaceBackground(ctx, first.ID, "image/jpeg", []byte("wallpaper-bytes")); err != nil {
		t.Fatalf("save background: %v", err)
	}
	ws, err := st.LoadWorkspace(ctx, first.ID)
	if err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	ws.BackgroundMode = "center"
	if err := st.SaveWorkspace(ctx, ws); err != nil {
		t.Fatalf("save workspace mode: %v", err)
	}
	if err := st.ActivateSession(ctx, "alice", first.ID); err != nil {
		t.Fatalf("activate session: %v", err)
	}

	second, err := st.CreateSession(ctx, "alice", "Project")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	bg, err := st.LoadWorkspaceBackground(ctx, second.ID)
	if err != nil {
		t.Fatalf("load new session background: %v", err)
	}
	if bg.MimeType != "image/jpeg" || string(bg.Image) != "wallpaper-bytes" {
		t.Fatalf("copied background = %+v", bg)
	}
	secondWS, err := st.LoadWorkspace(ctx, second.ID)
	if err != nil {
		t.Fatalf("load new session workspace: %v", err)
	}
	if secondWS.BackgroundMode != "center" {
		t.Fatalf("copied background mode = %q", secondWS.BackgroundMode)
	}
}

func TestLegacyWorkspaceMigratesToDefaultSession(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy.sqlite3")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open legacy database: %v", err)
	}
	_, err = db.Exec(`
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active_pane_id TEXT NOT NULL DEFAULT '',
  layout_json TEXT NOT NULL DEFAULT '{}',
  background_mode TEXT NOT NULL DEFAULT 'fill',
  default_pane_font_size INTEGER NOT NULL DEFAULT 14,
  default_theme TEXT NOT NULL DEFAULT 'next-tessera',
  theme_id TEXT NOT NULL DEFAULT 'next-tessera',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO workspaces (id, name, default_pane_font_size, default_theme, theme_id, created_at, updated_at)
VALUES ('alice', 'alice', 18, 'studio', 'hacker', '2026-01-01', '2026-01-02');`)
	if err != nil {
		t.Fatalf("create legacy database: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	st, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("migrate store: %v", err)
	}
	defer st.Close()
	sessions, err := st.ListSessions(ctx, "alice")
	if err != nil {
		t.Fatalf("list migrated sessions: %v", err)
	}
	if len(sessions) != 1 || sessions[0].ID != "alice" || sessions[0].Name != "Default" {
		t.Fatalf("migrated sessions = %+v", sessions)
	}
	settings, err := st.LoadUserSettings(ctx, "alice")
	if err != nil {
		t.Fatalf("load migrated settings: %v", err)
	}
	if settings.DefaultPaneFontSize != 18 || settings.DefaultTheme != "studio" || settings.ThemeID != "hacker" || !settings.DeskbarButtonEnabled ||
		settings.TerminalWheelSensitivity != 1 || settings.EditorWheelSensitivity != 1 || settings.OLEDWindowBorderSize != 10 {
		t.Fatalf("migrated settings = %+v", settings)
	}
}
