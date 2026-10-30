package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestSettingsFinalSaveOrdering(t *testing.T) {
	for _, order := range []string{"pending-first", "final-first", "other-browser"} {
		t.Run(order, func(t *testing.T) {
			ctx := context.Background()
			st, err := Open(ctx, filepath.Join(t.TempDir(), "settings.sqlite3"))
			if err != nil {
				t.Fatal(err)
			}
			defer st.Close()
			initial, err := st.LoadUserSettings(ctx, "alice")
			if err != nil {
				t.Fatal(err)
			}
			if initial.Revision == "" {
				t.Fatal("new settings have no revision")
			}
			pending := *initial
			pending.NextRevision = "11111111111111111111111111111111"
			pending.OLEDWindowBorderSize = 3
			final := *initial
			final.NextRevision = "22222222222222222222222222222222"
			final.AlternateRevision = pending.NextRevision
			final.OLEDWindowBorderSize = 17
			if order != "final-first" {
				if err := st.SaveUserSettings(ctx, &pending); err != nil {
					t.Fatal(err)
				}
			}
			if order == "other-browser" {
				other := pending
				other.OLEDWindowBorderSize = 8
				if err := st.SaveUserSettings(ctx, &other); err != nil {
					t.Fatal(err)
				}
				if err := st.SaveUserSettings(ctx, &final); !errors.Is(err, ErrSettingsConflict) {
					t.Fatalf("overwrote other browser: %v", err)
				}
				return
			}
			if err := st.SaveUserSettings(ctx, &final); err != nil {
				t.Fatal(err)
			}
			if order == "final-first" {
				if err := st.SaveUserSettings(ctx, &pending); !errors.Is(err, ErrSettingsConflict) {
					t.Fatalf("older save overwrote final settings: %v", err)
				}
			}
			loaded, err := st.LoadUserSettings(ctx, "alice")
			if err != nil {
				t.Fatal(err)
			}
			if loaded.OLEDWindowBorderSize != 17 || loaded.Revision != final.Revision {
				t.Fatalf("final settings lost: %+v", loaded)
			}
		})
	}
}

func TestPhoneSettingsStayApartFromDesktop(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "settings.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	desktop, err := st.LoadUserSettings(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	desktop.DeskbarButtonEnabled = false
	desktop.ThemeID = "hacker"
	desktop.Phone = nil
	if err := st.SaveUserSettings(ctx, desktop); err != nil {
		t.Fatal(err)
	}
	loaded, err := st.LoadUserSettings(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	// A phone starts from the defaults, not the desktop's choices.
	if loaded.Phone == nil || !loaded.Phone.DeskbarButtonEnabled || loaded.Phone.ThemeID != defaultThemeID {
		t.Fatalf("new phone settings = %+v", loaded.Phone)
	}

	loaded.Phone.ThemeID = "oled-terminal"
	loaded.Phone.TerminalFont = "fira-code"
	if err := st.SaveUserSettings(ctx, loaded); err != nil {
		t.Fatal(err)
	}
	// A page that predates phone settings saves without them.
	older, err := st.LoadUserSettings(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	older.Phone = nil
	older.ThemeID = "studio"
	if err := st.SaveUserSettings(ctx, older); err != nil {
		t.Fatal(err)
	}
	got, err := st.LoadUserSettings(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if got.ThemeID != "studio" || got.DeskbarButtonEnabled {
		t.Fatalf("desktop settings = %+v", got)
	}
	if got.Phone.ThemeID != "oled-terminal" || got.Phone.TerminalFont != "fira-code" || !got.Phone.DeskbarButtonEnabled {
		t.Fatalf("phone settings = %+v", got.Phone)
	}
}
