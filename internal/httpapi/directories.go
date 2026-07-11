package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

type directoryListResponse struct {
	Path      string           `json:"path"`
	Parent    string           `json:"parent"`
	Locations []directoryEntry `json:"locations"`
	Roots     []directoryEntry `json:"roots"`
	Entries   []directoryEntry `json:"entries"`
}

type directoryEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Kind string `json:"kind"`
}

func (a *API) listDirectories(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}

	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if path == "" {
		var err error
		path, err = os.Getwd()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	} else {
		abs, err := filepath.Abs(path)
		if err == nil {
			path = abs
		}
	}
	path = filepath.Clean(path)

	info, err := os.Stat(path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !info.IsDir() {
		writeError(w, http.StatusBadRequest, "path is not a directory")
		return
	}

	children, err := os.ReadDir(path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	includeFiles := r.URL.Query().Get("files") == "1"
	entries := make([]directoryEntry, 0, len(children))
	for _, child := range children {
		if !child.IsDir() && !includeFiles {
			continue
		}
		name := child.Name()
		kind := "file"
		if child.IsDir() {
			kind = "directory"
		}
		entries = append(entries, directoryEntry{
			Name: name,
			Path: filepath.Join(path, name),
			Kind: kind,
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Kind != entries[j].Kind {
			return entries[i].Kind == "directory"
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})

	writeJSON(w, http.StatusOK, directoryListResponse{
		Path:      path,
		Parent:    parentDirectory(path),
		Locations: directoryLocations(),
		Roots:     directoryRoots(),
		Entries:   entries,
	})
}

func parentDirectory(path string) string {
	parent := filepath.Dir(path)
	if parent == path || parent == "." {
		return ""
	}
	return parent
}

func directoryRoots() []directoryEntry {
	if runtime.GOOS != "windows" {
		return []directoryEntry{{Name: "/", Path: string(filepath.Separator), Kind: "directory"}}
	}

	var roots []directoryEntry
	for drive := 'A'; drive <= 'Z'; drive++ {
		path := string(drive) + `:\`
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			roots = append(roots, directoryEntry{Name: path, Path: path, Kind: "directory"})
		}
	}
	return roots
}

func directoryLocations() []directoryEntry {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return directoryLocationsFromHome(home)
}

func directoryLocationsFromHome(home string) []directoryEntry {
	candidates := []struct {
		name string
		path string
	}{
		{name: "Home", path: home},
		{name: "Desktop", path: filepath.Join(home, "Desktop")},
		{name: "Documents", path: filepath.Join(home, "Documents")},
		{name: "Downloads", path: filepath.Join(home, "Downloads")},
	}

	locations := make([]directoryEntry, 0, len(candidates))
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate.path); err == nil && info.IsDir() {
			locations = append(locations, directoryEntry{
				Name: candidate.name,
				Path: candidate.path,
				Kind: "directory",
			})
		}
	}
	return locations
}
