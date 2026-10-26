package store

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestSnippetsPersistenceIsolationAndConflict(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "snippets.db")
	st, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	first, err := st.LoadSnippets(ctx, "alice")
	if err != nil || len(first.Snippets) != 0 || first.Revision == "" {
		t.Fatalf("fresh = %+v, %v", first, err)
	}
	stale := *first
	first.Snippets = []Snippet{{ID: "a", Label: "Review", Text: "Review the diff for bugs.\nBe brief."}}
	if err := st.SaveSnippets(ctx, "alice", first); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveSnippets(ctx, "alice", &stale); !errors.Is(err, ErrSnippetsConflict) {
		t.Fatal("stale overwrite", err)
	}
	if bob, err := st.LoadSnippets(ctx, "bob"); err != nil || len(bob.Snippets) != 0 {
		t.Fatal("snippets crossed users", bob, err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	again, err := st.LoadSnippets(ctx, "alice")
	if err != nil || again.Revision != first.Revision || len(again.Snippets) != 1 || again.Snippets[0].Text != "Review the diff for bugs.\nBe brief." {
		t.Fatalf("reopened = %+v, %v", again, err)
	}
}

func TestSnippetsAreValidated(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "snippets.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	for name, snippets := range map[string][]Snippet{
		"no id":      {{Text: "ls"}},
		"same id":    {{ID: "a", Text: "ls"}, {ID: "a", Text: "pwd"}},
		"blank text": {{ID: "a", Text: " \n"}},
		"long label": {{ID: "a", Label: strings.Repeat("é", maximumSnippetLabel+1), Text: "ls"}},
		"long text":  {{ID: "a", Text: strings.Repeat("x", maximumSnippetText+1)}},
		"not UTF-8":  {{ID: "a", Text: "\xff"}},
		"too many":   make([]Snippet, maximumSnippets+1),
	} {
		doc, err := st.LoadSnippets(ctx, "alice")
		if err != nil {
			t.Fatal(err)
		}
		doc.Snippets = snippets
		if err := st.SaveSnippets(ctx, "alice", doc); err == nil {
			t.Errorf("%s: saved", name)
		}
	}
	// A save before the account ever loaded them still checks the revision.
	if err := st.SaveSnippets(ctx, "carol", &Snippets{Revision: "guess", Snippets: []Snippet{{ID: "a", Text: "ls"}}}); !errors.Is(err, ErrSnippetsConflict) {
		t.Fatal("unloaded save", err)
	}
}
