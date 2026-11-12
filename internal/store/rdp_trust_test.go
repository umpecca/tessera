package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestRDPCertificateTrustPersistsAndIsIsolated(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "trust.sqlite3")
	st, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	fingerprint := strings.Repeat("ab", 32)
	if err := st.TrustRDPCertificate(ctx, "alice", "host.local:3389", fingerprint, ""); err != nil {
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
	for _, tc := range []struct{ user, target, want string }{
		{"alice", "host.local:3389", fingerprint},
		{"bob", "host.local:3389", ""},
		{"alice", "host.local:3390", ""},
		{"alice", "other.local:3389", ""},
	} {
		if got, err := st.RDPCertificateFingerprint(ctx, tc.user, tc.target); err != nil || got != tc.want {
			t.Fatalf("%s/%s = %q, %v; want %q", tc.user, tc.target, got, err, tc.want)
		}
	}
	for _, bad := range []string{"", "ab12", strings.Repeat("g", 64), strings.Repeat("AB", 32)} {
		if err := st.TrustRDPCertificate(ctx, "alice", "bad.local:3389", bad, ""); err == nil {
			t.Fatalf("stored invalid fingerprint %q", bad)
		}
	}
}

func TestRDPCertificateTrustCannotOverwriteNewerApproval(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "trust.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	const target = "host.local:3389"
	a, b, c := strings.Repeat("aa", 32), strings.Repeat("bb", 32), strings.Repeat("cc", 32)
	for _, step := range []struct {
		next, previous string
		conflict       bool
	}{
		{a, "", false}, {a, "", false}, // Concurrent same-certificate approvals are idempotent.
		{b, "", true}, {b, a, false},
		{a, a, true}, {c, a, true}, {c, b, false},
	} {
		err := st.TrustRDPCertificate(ctx, "alice", target, step.next, step.previous)
		if step.conflict && !errors.Is(err, ErrRDPCertificateConflict) || !step.conflict && err != nil {
			t.Fatalf("next=%s previous=%s: %v", step.next, step.previous, err)
		}
	}
	if got, _ := st.RDPCertificateFingerprint(ctx, "alice", target); got != c {
		t.Fatalf("latest approval = %q", got)
	}
	// Both dialogs saw no saved pin. Only one different certificate may win.
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, fingerprint := range []string{a, b} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- st.TrustRDPCertificate(ctx, "alice", "race.local:3389", fingerprint, "")
		}()
	}
	wg.Wait()
	close(results)
	conflicts := 0
	for err := range results {
		if errors.Is(err, ErrRDPCertificateConflict) {
			conflicts++
		} else if err != nil {
			t.Fatal(err)
		}
	}
	if conflicts != 1 {
		t.Fatalf("concurrent different approvals: %d conflicts, want 1", conflicts)
	}
}

func TestRDPCertificateTrustMigrationPreservesLegacyPaneSettings(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "before-trust.sqlite3"))
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
		if migration.version >= 59 {
			break
		}
		if err := st.applyMigration(ctx, migration); err != nil {
			t.Fatal(err)
		}
	}
	workspace, err := st.LoadDefaultWorkspace(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	fingerprint := strings.Repeat("ab", 32)
	workspace.Panes = []Pane{{ID: "rdp", Kind: "rdp", RDPTarget: "host.local:3389", RDPTrustedTarget: "host.local:3389", RDPTrustedFingerprint: fingerprint}}
	if err := st.SaveWorkspace(ctx, workspace); err != nil {
		t.Fatal(err)
	}
	if err := st.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	loaded, err := st.LoadWorkspace(ctx, workspace.ID)
	if err != nil || len(loaded.Panes) != 1 || loaded.Panes[0].RDPTrustedFingerprint != fingerprint {
		t.Fatalf("migrated pane: %+v, %v", loaded, err)
	}
	if got, err := st.RDPCertificateFingerprint(ctx, "default", "host.local:3389"); err != nil || got != "" {
		t.Fatalf("migration silently learned trust: %q, %v", got, err)
	}
	assertTableColumns(t, db, "rdp_certificate_trust", []string{"user_id", "target", "fingerprint", "updated_at"})
}
