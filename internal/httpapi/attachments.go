package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// attachmentLifetime is how long an attachment is kept. A program reads it
// soon after its path is sent, so older ones are only taking up room.
const attachmentLifetime = 7 * 24 * time.Hour

var attachmentNameUnsafe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)
var attachmentNameDashes = regexp.MustCompile(`-{2,}`)

// attachmentDirectory is where images sent from the phone view are kept: a
// folder of the account's own cache folder, never a shared temporary
// folder another account could put a link into first.
var attachmentDirectory = func() (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	directory := filepath.Join(cache, "tessera", "attachments")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("the attachments folder is not a folder")
	}
	return directory, nil
}

// attachmentName keeps a recognisable, shell-safe part of the name the
// phone gave, after the time and a few random characters that make it
// unique: 20261026-153012-a1b2-IMG_0001.jpeg.
func attachmentName(original string, now time.Time) string {
	base := filepath.Base(strings.ReplaceAll(original, `\`, "/"))
	extension := strings.ToLower(filepath.Ext(base))
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	stem = attachmentNameDashes.ReplaceAllString(attachmentNameUnsafe.ReplaceAllString(stem, "-"), "-")
	stem = strings.Trim(stem, "-.")
	extension = attachmentNameUnsafe.ReplaceAllString(extension, "")
	if len(stem) > 40 {
		stem = stem[:40]
	}
	if stem == "" {
		stem = "image"
	}
	if len(extension) < 2 || len(extension) > 6 {
		extension = ".bin"
	}
	var random [2]byte
	_, _ = rand.Read(random[:])
	return now.Format("20060102-150405") + "-" + hex.EncodeToString(random[:]) + "-" + stem + extension
}

// uploadAttachment serves POST /api/host/attachments?name=: an image (or
// other file) sent from the phone view, kept on the host so its path can
// go to a program such as Claude Code. The body is the file. It answers
// { "path": ... }. Writing goes through uploadFile, with its size limit,
// staging and refusal to follow links.
func (a *API) uploadAttachment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	directory, err := attachmentDirectory()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "no folder for attachments: "+err.Error())
		return
	}
	pruneAttachments(directory, time.Now())
	query := url.Values{"directory": {directory}, "name": {attachmentName(r.URL.Query().Get("name"), time.Now())}}
	upload := r.Clone(r.Context())
	upload.URL.RawQuery = query.Encode()
	outcome := &uploadOutcome{header: make(http.Header)}
	a.uploadFile(outcome, upload)
	for name, values := range outcome.header {
		w.Header()[name] = values
	}
	if outcome.status != http.StatusCreated {
		w.WriteHeader(outcome.status)
		_, _ = w.Write(outcome.body)
		return
	}
	var result struct {
		Path string `json:"path"`
	}
	if json.Unmarshal(outcome.body, &result) != nil || result.Path == "" {
		writeError(w, http.StatusInternalServerError, "the attachment was saved without a path")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"path": result.Path})
}

func pruneAttachments(directory string, now time.Time) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || now.Sub(info.ModTime()) < attachmentLifetime {
			continue
		}
		_ = os.Remove(filepath.Join(directory, entry.Name()))
	}
}
