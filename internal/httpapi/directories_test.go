package httpapi

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type unavailableDirectoryEntry struct {
	name string
}

func (entry unavailableDirectoryEntry) Name() string         { return entry.name }
func (unavailableDirectoryEntry) IsDir() bool                { return false }
func (unavailableDirectoryEntry) Type() os.FileMode          { return 0 }
func (unavailableDirectoryEntry) Info() (os.FileInfo, error) { return nil, errors.New("unavailable") }

func TestDirectoryLocationsFromHomeIncludesExistingFolders(t *testing.T) {
	home := t.TempDir()
	for _, name := range []string{"Desktop", "Documents"} {
		if err := os.Mkdir(filepath.Join(home, name), 0o755); err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
	}

	locations := directoryLocationsFromHome(home)
	if len(locations) != 3 {
		t.Fatalf("location count = %d, want 3", len(locations))
	}

	wantNames := []string{"Home", "Desktop", "Documents"}
	for index, want := range wantNames {
		if locations[index].Name != want {
			t.Errorf("location %d name = %q, want %q", index, locations[index].Name, want)
		}
		if locations[index].Kind != "directory" {
			t.Errorf("location %d kind = %q, want directory", index, locations[index].Kind)
		}
	}
}

func TestDirectoryEntryFromChildReportsRegularFileSizes(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "filled.bin"), make([]byte, 1536), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "empty.bin"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "folder"), 0o755); err != nil {
		t.Fatal(err)
	}

	children, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	entries := make(map[string]directoryEntry, len(children))
	for _, child := range children {
		entries[child.Name()] = directoryEntryFromChild(dir, child)
	}

	if size := entries["filled.bin"].Size; size == nil || *size != 1536 {
		t.Fatalf("filled size = %v, want 1536", size)
	}
	if size := entries["empty.bin"].Size; size == nil || *size != 0 {
		t.Fatalf("empty size = %v, want 0", size)
	}
	if entry := entries["folder"]; entry.Kind != "directory" || entry.Size != nil {
		t.Fatalf("directory entry = %#v, want directory with no size", entry)
	}
}

func TestDirectoryEntryFromChildToleratesUnavailableMetadata(t *testing.T) {
	dir := t.TempDir()
	entry := directoryEntryFromChild(dir, unavailableDirectoryEntry{name: "gone.txt"})
	if entry.Kind != "file" || entry.Size != nil {
		t.Fatalf("unavailable entry = %#v, want file with nil size", entry)
	}
}
