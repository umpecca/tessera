package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"tessera/internal/shortcuts"
)

func TestShortcutsPersistenceIsolationAndConflict(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "shortcuts.db")
	st, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	first, err := st.LoadShortcuts(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	stale, err := st.LoadShortcuts(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	first.Shortcuts = []shortcuts.Shortcut{{ID: "editor", Name: "Editor", Code: "CE", Command: "fresh", Fields: []shortcuts.Field{{ID: "file", Label: "File", Type: "text", Default: "draft.txt"}}}}
	if err := st.SaveShortcuts(ctx, "alice", first); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveShortcuts(ctx, "alice", stale); !errors.Is(err, ErrShortcutsConflict) {
		t.Fatal("stale overwrite", err)
	}
	bob, err := st.LoadShortcuts(ctx, "bob")
	if err != nil || len(bob.Shortcuts) != 0 {
		t.Fatal("shortcuts crossed users", bob, err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	loaded, err := st.LoadShortcuts(ctx, "alice")
	if err != nil || loaded.Revision != first.Revision || loaded.Shortcuts[0].Fields[0].Default != "draft.txt" {
		t.Fatal("reopen lost definitions", loaded, err)
	}
	loaded.Shortcuts[0].Code = "NN"
	if err := st.SaveShortcuts(ctx, "alice", loaded); err == nil {
		t.Fatal("conflict accepted")
	}
	loaded.Shortcuts = nil
	if err := st.SaveShortcuts(ctx, "alice", loaded); err != nil {
		t.Fatal(err)
	}
	empty, err := st.LoadShortcuts(ctx, "alice")
	if err != nil || len(empty.Shortcuts) != 0 {
		t.Fatal("delete failed", err)
	}
}
