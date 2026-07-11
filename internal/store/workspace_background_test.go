package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

func TestWorkspaceBackgroundRoundTrip(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	if _, err := st.LoadOrCreateWorkspace(ctx, "alice", "alice"); err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	// No background yet.
	if _, err := st.LoadWorkspaceBackground(ctx, "alice"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("expected sql.ErrNoRows, got %v", err)
	}
	ws, err := st.LoadWorkspace(ctx, "alice")
	if err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	if ws.HasBackground {
		t.Fatal("workspace should not report a background before one is set")
	}

	// Save a background.
	image := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02}
	version, err := st.SaveWorkspaceBackground(ctx, "alice", "image/png", image)
	if err != nil {
		t.Fatalf("save background: %v", err)
	}
	if version == "" {
		t.Fatal("save should return a version stamp")
	}

	bg, err := st.LoadWorkspaceBackground(ctx, "alice")
	if err != nil {
		t.Fatalf("load background: %v", err)
	}
	if bg.MimeType != "image/png" {
		t.Errorf("mime = %q, want image/png", bg.MimeType)
	}
	if string(bg.Image) != string(image) {
		t.Errorf("image bytes did not round-trip")
	}
	if bg.UpdatedAt != version {
		t.Errorf("updatedAt = %q, want %q", bg.UpdatedAt, version)
	}

	ws, err = st.LoadWorkspace(ctx, "alice")
	if err != nil {
		t.Fatalf("reload workspace: %v", err)
	}
	if !ws.HasBackground || ws.BackgroundVersion != version {
		t.Errorf("workspace background meta = (%v, %q), want (true, %q)", ws.HasBackground, ws.BackgroundVersion, version)
	}

	// Background is isolated per workspace.
	if _, err := st.LoadWorkspaceBackground(ctx, "bob"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("bob should have no background, got %v", err)
	}

	// Delete clears it (and deleting again is not an error).
	if err := st.DeleteWorkspaceBackground(ctx, "alice"); err != nil {
		t.Fatalf("delete background: %v", err)
	}
	if err := st.DeleteWorkspaceBackground(ctx, "alice"); err != nil {
		t.Fatalf("delete missing background should be a no-op, got %v", err)
	}
	if _, err := st.LoadWorkspaceBackground(ctx, "alice"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("expected sql.ErrNoRows after delete, got %v", err)
	}
}
