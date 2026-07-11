package httpapi

import (
	"os"
	"path/filepath"
	"testing"
)

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
