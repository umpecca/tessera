package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestInterfaceFontSizeNormalization(t *testing.T) {
	for _, value := range []int{10, 12, 14, 16, 18} {
		if got := normalizeInterfaceFontSize(value); got != value {
			t.Errorf("normalizeInterfaceFontSize(%d) = %d", value, got)
		}
	}
	for _, value := range []int{-1, 0, 9, 19, 100} {
		if got := normalizeInterfaceFontSize(value); got != DefaultInterfaceFontSize {
			t.Errorf("normalizeInterfaceFontSize(%d) = %d", value, got)
		}
	}
}

func TestInterfaceFontSizesPersistIndependentlyFromTerminalSizes(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "interface-font.sqlite3")
	st, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	settings, err := st.LoadUserSettings(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if settings.InterfaceFontSize != 12 || settings.Phone.InterfaceFontSize != 12 {
		t.Fatalf("default interface font sizes = %+v", settings)
	}
	settings.InterfaceFontSize = 18
	settings.DefaultPaneFontSize = 15
	settings.Phone.InterfaceFontSize = 14
	settings.Phone.DefaultPaneFontSize = 17
	if err := st.SaveUserSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	// A desktop-only save must not reset the phone's independently stored size.
	settings.Phone = nil
	settings.InterfaceFontSize = 16
	if err := st.SaveUserSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	loaded, err := st.LoadUserSettings(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if loaded.InterfaceFontSize != 16 || loaded.DefaultPaneFontSize != 15 || loaded.Phone.InterfaceFontSize != 14 || loaded.Phone.DefaultPaneFontSize != 17 {
		t.Fatalf("interface/terminal sizes changed: %+v, phone: %+v", loaded, loaded.Phone)
	}
	loaded.InterfaceFontSize = 999
	loaded.Phone.InterfaceFontSize = -1
	if err := st.SaveUserSettings(ctx, loaded); err != nil {
		t.Fatal(err)
	}
	loaded, err = st.LoadUserSettings(ctx, "alice")
	if err != nil || loaded.InterfaceFontSize != 12 || loaded.Phone.InterfaceFontSize != 12 {
		t.Fatalf("invalid stored sizes were not normalized: %+v, %v", loaded, err)
	}
}

func TestInterfaceFontMigrationPreservesExistingTerminalSettings(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "before-interface-font.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	st := &Store{db: db}
	migrations, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	for _, migration := range migrations {
		if migration.version >= 58 {
			break
		}
		if err := st.applyMigration(ctx, migration); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO user_settings (user_id, default_pane_font_size, terminal_font, phone_settings, created_at, updated_at)
VALUES ('alice', 18, 'cozette', '{"defaultPaneFontSize":16,"terminalFont":"spleen"}', 'before', 'before')`); err != nil {
		t.Fatal(err)
	}
	if err := st.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	settings, err := st.LoadUserSettings(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if settings.InterfaceFontSize != 12 || settings.Phone.InterfaceFontSize != 12 || settings.DefaultPaneFontSize != 18 || settings.Phone.DefaultPaneFontSize != 16 || settings.TerminalFont != "cozette" || settings.Phone.TerminalFont != "spleen" {
		t.Fatalf("migration changed existing text settings: %+v, phone: %+v", settings, settings.Phone)
	}
}
