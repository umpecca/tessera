package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestMigrationsCreateCurrentSchemaAndAreIdempotent(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "fresh.sqlite3")

	st, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("open fresh store: %v", err)
	}
	migrations, err := loadMigrations()
	if err != nil {
		t.Fatalf("load migrations: %v", err)
	}
	version, err := st.userVersion(ctx)
	if err != nil {
		t.Fatalf("read migration version: %v", err)
	}
	if want := migrations[len(migrations)-1].version; version != want {
		t.Fatalf("migration version = %d, want %d", version, want)
	}

	assertTableColumns(t, st.db, "workspaces", []string{
		"id", "owner_id", "name", "active_pane_id", "layout_json",
		"background_mode", "default_pane_font_size", "default_theme",
		"theme_id", "last_opened_at", "created_at", "updated_at",
	})
	assertTableColumns(t, st.db, "panes", []string{
		"id", "workspace_id", "kind", "title", "buffer_text", "editor_mode",
		"font_size", "cwd", "last_export_path", "editor_tabs",
		"file_browser_sidebar_width", "is_full", "restore_box", "minimized",
		"x", "y", "width", "height", "z_index", "position", "created_at",
		"updated_at",
	})
	assertTableColumns(t, st.db, "audio_station", []string{
		"id", "source_kind", "source_value", "workspace_id", "pane_id",
		"position_seconds", "source_version", "state_version", "updated_at",
	})
	assertTableColumns(t, st.db, "audit_events", []string{
		"id", "occurred_at", "request_id", "client_ip", "method", "path",
		"status", "outcome", "duration_ms",
	})
	for _, table := range []string{"command_runs", "workspace_backgrounds", "user_settings"} {
		exists, err := st.tableExists(ctx, table)
		if err != nil {
			t.Fatalf("inspect table %s: %v", table, err)
		}
		if !exists {
			t.Fatalf("table %s was not created", table)
		}
	}
	assertTableColumns(t, st.db, "user_settings", []string{
		"user_id", "default_pane_font_size", "default_theme", "theme_id",
		"deskbar_button_enabled", "created_at", "updated_at",
	})
	if err := st.Close(); err != nil {
		t.Fatalf("close fresh store: %v", err)
	}

	reopened, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("reopen migrated store: %v", err)
	}
	defer reopened.Close()
	reopenedVersion, err := reopened.userVersion(ctx)
	if err != nil {
		t.Fatalf("read reopened migration version: %v", err)
	}
	if reopenedVersion != version {
		t.Fatalf("reopened migration version = %d, want %d", reopenedVersion, version)
	}
}

func TestValidateMigrationSequenceRejectsGapsAndDuplicates(t *testing.T) {
	tests := []struct {
		name       string
		migrations []migration
	}{
		{name: "empty"},
		{name: "missing first", migrations: []migration{{version: 2}}},
		{name: "gap", migrations: []migration{{version: 1}, {version: 3}}},
		{name: "duplicate", migrations: []migration{{version: 1}, {version: 1}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := validateMigrationSequence(test.migrations); err == nil {
				t.Fatal("validateMigrationSequence() succeeded, want error")
			}
		})
	}
}

func TestApplyMigrationRollsBackSchemaAndVersionTogether(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "rollback.sqlite3"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	st := &Store{db: db}

	err = st.applyMigration(ctx, migration{
		version: 1,
		name:    "001_broken.sql",
		sql:     "CREATE TABLE should_rollback (id TEXT); INVALID SQL;",
	})
	if err == nil {
		t.Fatal("applyMigration() succeeded, want error")
	}
	exists, err := st.tableExists(ctx, "should_rollback")
	if err != nil {
		t.Fatalf("inspect rolled-back table: %v", err)
	}
	if exists {
		t.Fatal("failed migration left its schema change behind")
	}
	version, err := st.userVersion(ctx)
	if err != nil {
		t.Fatalf("read rolled-back version: %v", err)
	}
	if version != 0 {
		t.Fatalf("migration version = %d after rollback, want 0", version)
	}
}

func TestUnversionedCurrentSchemaAdoptionPreservesNamedSessions(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "unversioned-current.sqlite3")

	st, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	first, err := st.EnsureUserDefaultSession(ctx, "alice")
	if err != nil {
		t.Fatalf("ensure default session: %v", err)
	}
	second, err := st.CreateSession(ctx, "alice", "Project")
	if err != nil {
		t.Fatalf("create second session: %v", err)
	}
	if err := st.SaveUserSettings(ctx, &UserSettings{
		UserID:               "alice",
		DefaultPaneFontSize:  18,
		DefaultTheme:         "studio",
		ThemeID:              "hacker",
		DeskbarButtonEnabled: true,
	}); err != nil {
		t.Fatalf("save user settings: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open raw database: %v", err)
	}
	if _, err := db.Exec("PRAGMA user_version = 0"); err != nil {
		t.Fatalf("clear migration version: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close raw database: %v", err)
	}

	adopted, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("adopt unversioned current schema: %v", err)
	}
	defer adopted.Close()
	sessions, err := adopted.ListSessions(ctx, "alice")
	if err != nil {
		t.Fatalf("list adopted sessions: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("adopted session count = %d, want 2: %+v", len(sessions), sessions)
	}
	names := map[string]string{}
	for _, session := range sessions {
		names[session.ID] = session.Name
	}
	if names[first.ID] != "Default" || names[second.ID] != "Project" {
		t.Fatalf("adopted session names changed: %+v", sessions)
	}
	settings, err := adopted.LoadUserSettings(ctx, "alice")
	if err != nil {
		t.Fatalf("load adopted settings: %v", err)
	}
	if settings.DefaultPaneFontSize != 18 || settings.DefaultTheme != "studio" || settings.ThemeID != "hacker" || !settings.DeskbarButtonEnabled {
		t.Fatalf("adopted settings changed: %+v", settings)
	}
}

func assertTableColumns(t *testing.T, db *sql.DB, table string, expected []string) {
	t.Helper()
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		t.Fatalf("inspect table %s: %v", table, err)
	}
	defer rows.Close()

	actual := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, columnType string
		var notNull int
		var defaultValue sql.NullString
		var primaryKey int
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			t.Fatalf("scan table %s: %v", table, err)
		}
		actual[name] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate table %s: %v", table, err)
	}
	for _, column := range expected {
		if !actual[column] {
			t.Errorf("table %s is missing column %s", table, column)
		}
	}
}
