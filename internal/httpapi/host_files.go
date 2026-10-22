package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"sync"
)

// maxSavedHostFiles bounds what saveHostFile remembers for deletion.
const maxSavedHostFiles = 256

// savedHostFiles remembers the files saveHostFile wrote, so that deleting them
// later removes only those files, and only while they are as Tessera left them.
// It lives in memory: after a restart there is nothing to delete.
type savedHostFiles struct {
	mu    sync.Mutex
	files map[string]os.FileInfo
	order []string
}

func (s *savedHostFiles) remember(path string, info os.FileInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.files == nil {
		s.files = make(map[string]os.FileInfo)
	}
	if _, known := s.files[path]; !known {
		s.order = append(s.order, path)
	}
	s.files[path] = info
	for len(s.order) > maxSavedHostFiles {
		delete(s.files, s.order[0])
		s.order = s.order[1:]
	}
}

func (s *savedHostFiles) forget(path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.files, path)
	for index, known := range s.order {
		if known == path {
			s.order = append(s.order[:index], s.order[index+1:]...)
			break
		}
	}
}

func (s *savedHostFiles) lookup(path string) (os.FileInfo, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	info, ok := s.files[path]
	return info, ok
}

// saveHostFile writes one file the browser chose to save on the host, such
// as the clipboard's contents from the Save Clipboard to File dialog. The body
// is the raw file; the query names the destination directory, a single file
// name, and overwrite=1 once the person has agreed to replace an existing
// file. Storage is uploadFile's: staged beside the destination, never through
// a symlink, and replacing only a regular file. A signed-in browser can
// already write anywhere the host account can through a terminal, so this
// grants nothing new; it is behind sign-in and the origin check like every
// other API route.
func (a *API) saveHostFile(w http.ResponseWriter, r *http.Request) {
	outcome := &uploadOutcome{header: make(http.Header)}
	a.uploadFile(outcome, r)
	if outcome.status == http.StatusCreated {
		var result struct {
			Path string `json:"path"`
		}
		if json.Unmarshal(outcome.body, &result) == nil && result.Path != "" {
			if info, err := os.Lstat(result.Path); err == nil {
				a.savedHostFiles.remember(result.Path, info)
			}
		}
	}
	for name, values := range outcome.header {
		w.Header()[name] = values
	}
	w.WriteHeader(outcome.status)
	_, _ = w.Write(outcome.body)
}

type deleteHostFilesResult struct {
	Deleted []string       `json:"deleted"`
	Kept    []keptHostFile `json:"kept"`
}

type keptHostFile struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// deleteHostFiles removes files saveHostFile wrote. It refuses any other path,
// and a file that has changed since it was saved, so it can only undo a save.
func (a *API) deleteHostFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var request struct {
		Paths []string `json:"paths"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || len(request.Paths) == 0 || len(request.Paths) > maxSavedHostFiles {
		writeError(w, http.StatusBadRequest, "expected the paths of saved files")
		return
	}
	result := deleteHostFilesResult{Deleted: []string{}, Kept: []keptHostFile{}}
	for _, path := range request.Paths {
		if reason := a.deleteSavedHostFile(path); reason != "" {
			result.Kept = append(result.Kept, keptHostFile{Path: path, Reason: reason})
		} else {
			result.Deleted = append(result.Deleted, path)
		}
	}
	writeJSON(w, http.StatusOK, result)
}

// deleteSavedHostFile returns why path was kept, or "" once it is deleted.
func (a *API) deleteSavedHostFile(path string) string {
	saved, ok := a.savedHostFiles.lookup(path)
	if !ok {
		return "Tessera did not save this file, or has restarted since"
	}
	current, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		a.savedHostFiles.forget(path)
		return "already gone"
	}
	if err != nil {
		return err.Error()
	}
	if !current.Mode().IsRegular() || !os.SameFile(saved, current) ||
		current.Size() != saved.Size() || !current.ModTime().Equal(saved.ModTime()) {
		return "changed since it was saved"
	}
	if err := os.Remove(path); err != nil {
		return err.Error()
	}
	a.savedHostFiles.forget(path)
	return ""
}
