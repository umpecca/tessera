package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"tessera/internal/shortcuts"
	"tessera/internal/store"
	"tessera/internal/terminal"
)

func shortcutJSON(w http.ResponseWriter, r *http.Request, value any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 256*1024)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(value); err != nil {
		return errors.New("invalid or oversized shortcut JSON")
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func (a *API) userShortcuts(w http.ResponseWriter, r *http.Request, userID, id, action string) {
	if id != "" {
		a.launchShortcut(w, r, userID, id, action)
		return
	}
	switch r.Method {
	case http.MethodGet:
		doc, err := a.Store.LoadShortcuts(r.Context(), userID)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"revision": doc.Revision, "shortcuts": doc.Shortcuts, "reservedCodes": shortcuts.ReservedCodes, "shell": terminal.ShortcutShell()})
	case http.MethodPut:
		var doc store.Shortcuts
		if err := shortcutJSON(w, r, &doc); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		for _, s := range doc.Shortcuts {
			if s.Cwd != "" && !filepath.IsAbs(s.Cwd) {
				writeError(w, 400, "working directory must be an absolute host path, or empty")
				return
			}
		}
		if err := a.Store.SaveShortcuts(r.Context(), userID, &doc); errors.Is(err, store.ErrShortcutsConflict) {
			writeError(w, 409, err.Error())
			return
		} else if err != nil {
			writeError(w, 400, err.Error())
			return
		}
		writeJSON(w, 200, doc)
	default:
		methodNotAllowed(w, "GET, PUT")
	}
}

func (a *API) launchShortcut(w http.ResponseWriter, r *http.Request, userID, id, action string) {
	test := id == "test" && action == ""
	if !test && action != "launch" {
		writeError(w, 404, "not found")
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w, "POST")
		return
	}
	var req struct {
		WorkspaceID string              `json:"workspaceId"`
		Cwd         string              `json:"cwd"`
		Values      map[string]any      `json:"values"`
		Shortcut    *shortcuts.Shortcut `json:"shortcut,omitempty"`
	}
	if err := shortcutJSON(w, r, &req); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	if req.WorkspaceID == "" || !a.workspaceAllowed(r.Context(), req.WorkspaceID) {
		writeError(w, 404, "unknown session")
		return
	}
	ws, err := a.Store.LoadWorkspace(r.Context(), req.WorkspaceID)
	if err != nil || ws.OwnerID != userID {
		writeError(w, 404, "unknown session")
		return
	}
	var selected shortcuts.Shortcut
	if test {
		if req.Shortcut == nil {
			writeError(w, 400, "test shortcut is required")
			return
		}
		selected = *req.Shortcut
	} else {
		if req.Shortcut != nil {
			writeError(w, 400, "saved shortcut launches cannot override the command")
			return
		}
		doc, err := a.Store.LoadShortcuts(r.Context(), userID)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		for _, s := range doc.Shortcuts {
			if s.ID == id {
				selected = s
				break
			}
		}
		if selected.ID == "" {
			writeError(w, 404, "shortcut no longer exists")
			return
		}
	}
	command, err := shortcuts.Build(selected, req.Values, terminal.ShortcutShell())
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	cwd := selected.Cwd
	if cwd == "" {
		cwd = req.Cwd
	}
	if cwd != "" {
		if !shortcuts.SafeText(cwd, 4096) || !filepath.IsAbs(cwd) {
			writeError(w, 400, "working directory must be an absolute host path")
			return
		}
		info, err := os.Stat(cwd)
		if err != nil || !info.IsDir() {
			writeError(w, 400, "working directory does not exist on the host")
			return
		}
	}
	// PowerShell requires the call operator when the authored command starts with
	// a quoted executable path. The author supplies it in the base command.
	writeJSON(w, 200, map[string]string{"title": strings.TrimSpace(selected.Name), "cwd": cwd, "command": command})
}
