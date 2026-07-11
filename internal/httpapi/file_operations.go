package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type fileOperationRequest struct {
	Action      string `json:"action"`
	Source      string `json:"source"`
	Destination string `json:"destination"`
}

func (a *API) fileOperations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}

	var req fileOperationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid file operation JSON")
		return
	}
	req.Action = strings.ToLower(strings.TrimSpace(req.Action))
	req.Source = cleanFilePath(req.Source)
	req.Destination = cleanFilePath(req.Destination)

	if req.Source == "" {
		writeError(w, http.StatusBadRequest, "source path is required")
		return
	}
	if isFilesystemRoot(req.Source) {
		writeError(w, http.StatusBadRequest, "filesystem roots cannot be changed")
		return
	}
	sourceInfo, err := os.Lstat(req.Source)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	switch req.Action {
	case "copy", "move":
		target, status, err := copyOrMovePath(req.Action, req.Source, req.Destination, sourceInfo)
		if err != nil {
			writeError(w, status, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{
			"action": req.Action,
			"path":   target,
			"status": "ok",
		})
	case "delete":
		if err := os.RemoveAll(req.Source); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{
			"action": req.Action,
			"path":   req.Source,
			"status": "ok",
		})
	default:
		writeError(w, http.StatusBadRequest, "action must be copy, move, or delete")
	}
}

func copyOrMovePath(action, source, destination string, sourceInfo os.FileInfo) (string, int, error) {
	if destination == "" {
		return "", http.StatusBadRequest, errors.New("destination folder is required")
	}
	destinationInfo, err := os.Stat(destination)
	if err != nil {
		return "", http.StatusBadRequest, err
	}
	if !destinationInfo.IsDir() {
		return "", http.StatusBadRequest, errors.New("destination is not a folder")
	}

	target := filepath.Join(destination, filepath.Base(source))
	if samePath(source, target) {
		return "", http.StatusConflict, errors.New("source and destination are the same")
	}
	if sourceInfo.IsDir() && pathInside(target, source) {
		return "", http.StatusBadRequest, errors.New("a folder cannot be placed inside itself")
	}
	if _, err := os.Lstat(target); err == nil {
		return "", http.StatusConflict, fmt.Errorf("%s already exists", target)
	} else if !os.IsNotExist(err) {
		return "", http.StatusBadRequest, err
	}

	if action == "move" {
		if err := os.Rename(source, target); err == nil {
			return target, http.StatusOK, nil
		}
	}

	if err := copyPath(source, target); err != nil {
		_ = os.RemoveAll(target)
		return "", http.StatusBadRequest, err
	}
	if action == "move" {
		if err := os.RemoveAll(source); err != nil {
			return "", http.StatusBadRequest, fmt.Errorf("copied item but could not remove source: %w", err)
		}
	}
	return target, http.StatusOK, nil
}

func copyPath(source, target string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		link, err := os.Readlink(source)
		if err != nil {
			return err
		}
		return os.Symlink(link, target)
	}
	if info.IsDir() {
		if err := os.Mkdir(target, info.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(source)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := copyPath(filepath.Join(source, entry.Name()), filepath.Join(target, entry.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file or folder", source)
	}

	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		_ = output.Close()
		return err
	}
	return output.Close()
}

func isFilesystemRoot(path string) bool {
	return filepath.Dir(path) == path
}

func samePath(left, right string) bool {
	left = filepath.Clean(left)
	right = filepath.Clean(right)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func pathInside(path, parent string) bool {
	relative, err := filepath.Rel(parent, path)
	if err != nil || relative == "." || relative == ".." {
		return relative == "."
	}
	return !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
