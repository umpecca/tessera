package httpapi

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const DefaultMaxUploadBytes int64 = 1 << 30

func (a *API) downloadFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	path := cleanFilePath(r.URL.Query().Get("path"))
	if path == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !info.Mode().IsRegular() {
		writeError(w, http.StatusBadRequest, "path is not a regular file")
		return
	}
	disposition := mime.FormatMediaType("attachment", map[string]string{"filename": filepath.Base(path)})
	if disposition == "" {
		disposition = "attachment"
	}
	w.Header().Set("Content-Disposition", disposition)
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

func (a *API) uploadFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	directory := cleanFilePath(r.URL.Query().Get("directory"))
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if directory == "" {
		writeError(w, http.StatusBadRequest, "destination directory is required")
		return
	}
	if !validUploadName(name) {
		writeError(w, http.StatusBadRequest, "name must be a single file name")
		return
	}
	directoryInfo, err := os.Stat(directory)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !directoryInfo.IsDir() {
		writeError(w, http.StatusBadRequest, "destination is not a directory")
		return
	}
	overwrite := r.URL.Query().Get("overwrite") == "1"
	target := filepath.Join(directory, name)
	exists, status, err := validateUploadTarget(target, overwrite)
	if err != nil {
		writeError(w, status, err.Error())
		return
	}

	limit := a.MaxUploadBytes
	if limit <= 0 {
		limit = DefaultMaxUploadBytes
	}
	if r.ContentLength > limit {
		writeError(w, http.StatusRequestEntityTooLarge, "upload exceeds the maximum size")
		return
	}
	temporary, err := os.CreateTemp(directory, ".tessera-upload-*")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	temporaryPath := temporary.Name()
	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}()

	written, copyErr := io.Copy(temporary, io.LimitReader(r.Body, limit+1))
	if copyErr != nil {
		writeError(w, http.StatusBadRequest, copyErr.Error())
		return
	}
	if written > limit {
		writeError(w, http.StatusRequestEntityTooLarge, "upload exceeds the maximum size")
		return
	}
	if err := temporary.Chmod(0o644); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := temporary.Close(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if exists {
		err = replaceUploadedFile(temporaryPath, target)
	} else {
		err = linkUploadedFile(temporaryPath, target)
	}
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			writeError(w, http.StatusConflict, "destination file already exists")
		} else {
			writeError(w, http.StatusBadRequest, err.Error())
		}
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"path":   target,
		"status": "uploaded",
		"bytes":  written,
	})
}

func validUploadName(name string) bool {
	return name != "" && name != "." && name != ".." &&
		!filepath.IsAbs(name) && filepath.Base(name) == name &&
		!strings.ContainsAny(name, `/\`) && !strings.ContainsRune(name, 0)
}

func validateUploadTarget(target string, overwrite bool) (bool, int, error) {
	info, err := os.Lstat(target)
	if os.IsNotExist(err) {
		return false, http.StatusOK, nil
	}
	if err != nil {
		return false, http.StatusBadRequest, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return true, http.StatusBadRequest, errors.New("destination is not a regular file")
	}
	if !overwrite {
		return true, http.StatusConflict, errors.New("destination file already exists")
	}
	return true, http.StatusOK, nil
}

func linkUploadedFile(temporaryPath, target string) error {
	if err := os.Link(temporaryPath, target); err == nil {
		return nil
	} else if errors.Is(err, os.ErrExist) {
		return err
	}
	// Some removable and network filesystems do not support hard links. The
	// second existence check preserves normal conflict behavior before using a
	// same-directory rename as the portable fallback.
	if _, err := os.Lstat(target); err == nil {
		return os.ErrExist
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.Rename(temporaryPath, target)
}

func replaceUploadedFile(temporaryPath, target string) error {
	info, err := os.Lstat(target)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errors.New("destination is not a regular file")
	}
	backup, err := os.CreateTemp(filepath.Dir(target), ".tessera-replaced-*")
	if err != nil {
		return err
	}
	backupPath := backup.Name()
	if err := backup.Close(); err != nil {
		_ = os.Remove(backupPath)
		return err
	}
	if err := os.Remove(backupPath); err != nil {
		return err
	}
	if err := os.Rename(target, backupPath); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, target); err != nil {
		_ = os.Rename(backupPath, target)
		return err
	}
	_ = os.Remove(backupPath)
	return nil
}
