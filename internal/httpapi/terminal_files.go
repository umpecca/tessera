package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"sync"
	"time"

	"tessera/internal/terminalfile"
)

// Only this inert target may be embedded by the app. Keep the main app's
// frame-ancestors restriction intact and keep credentials out of URLs.
func (a *API) terminalFileFrame(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'self'; form-action 'self'")
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	// Form navigation with no-referrer produces an opaque Origin in Chromium.
	// This inert same-origin document has no credentials in its URL and sends
	// its origin only to this server; ordinary app requests retain no-referrer.
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, "<!doctype html><title>File transfer</title>")
}

func decodeFileControl(r *http.Request, limit int64, value any) error {
	data, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > limit {
		return errors.New("file control exceeds its size limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("invalid trailing JSON")
	}
	return nil
}

func (a *API) claimTerminalFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if a.Terminals == nil || a.Terminals.Files == nil {
		writeError(w, 503, "terminal manager unavailable")
		return
	}
	var req struct {
		Workspace string              `json:"workspaceId"`
		Pane      string              `json:"paneId"`
		Epoch     string              `json:"epoch"`
		ID        string              `json:"id"`
		Client    string              `json:"clientId"`
		Files     []terminalfile.File `json:"files"`
	}
	if decodeFileControl(r, terminalfile.MaxMetadata, &req) != nil {
		writeError(w, 400, "invalid claim")
		return
	}
	if !a.workspaceAllowed(r.Context(), req.Workspace) {
		writeError(w, 404, "unknown session")
		return
	}
	a.Terminals.Files.SetMaxUpload(a.MaxUploadBytes)
	ticket, err := a.Terminals.Files.Claim(req.Workspace, req.Pane, req.Epoch, req.ID, req.Client, req.Files)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, terminalfile.ErrUnavailable) {
			status = http.StatusGone
		}
		writeError(w, status, err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"ticket": ticket})
}
func (a *API) fileTicket(w http.ResponseWriter, r *http.Request, ticket string) (*terminalfile.Transfer, bool) {
	if a.Terminals == nil || a.Terminals.Files == nil {
		writeError(w, 503, "terminal manager unavailable")
		return nil, false
	}
	t, ok := a.Terminals.Files.Lookup(ticket)
	if !ok || !a.workspaceAllowed(r.Context(), t.Workspace) {
		writeError(w, 410, "transfer unavailable")
		return nil, false
	}
	return t, true
}

type transferReader struct {
	io.Reader
	context    context.Context
	progress   func(int64) bool
	controller *http.ResponseController
}

func (r *transferReader) Read(p []byte) (int, error) {
	if err := r.context.Err(); err != nil {
		return 0, err
	}
	_ = r.controller.SetReadDeadline(time.Now().Add(2 * time.Minute))
	n, err := r.Reader.Read(p)
	if n > 0 && !r.progress(int64(n)) {
		return n, context.Canceled
	}
	return n, err
}

type transferWriter struct {
	io.Writer
	context    context.Context
	progress   func(int64) bool
	controller *http.ResponseController
}

func (w *transferWriter) Write(p []byte) (int, error) {
	if err := w.context.Err(); err != nil {
		return 0, err
	}
	_ = w.controller.SetWriteDeadline(time.Now().Add(2 * time.Minute))
	n, err := w.Writer.Write(p)
	if n > 0 && !w.progress(int64(n)) {
		return n, context.Canceled
	}
	return n, err
}
func transferCancellation(w http.ResponseWriter, ctx context.Context) func() {
	controller := http.NewResponseController(w)
	done := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		defer close(done)
		_ = controller.SetReadDeadline(time.Now())
		_ = controller.SetWriteDeadline(time.Now())
	})
	var once sync.Once
	return func() {
		once.Do(func() {
			if !stop() {
				<-done
			}
			_ = controller.SetReadDeadline(time.Time{})
			_ = controller.SetWriteDeadline(time.Time{})
		})
	}
}

// Capture the existing streamed upload's small JSON result, not its file bytes.
type uploadOutcome struct {
	header http.Header
	status int
	body   []byte
}

func (o *uploadOutcome) Header() http.Header { return o.header }
func (o *uploadOutcome) WriteHeader(s int)   { o.status = s }
func (o *uploadOutcome) Write(p []byte) (int, error) {
	o.body = append(o.body, p...)
	return len(p), nil
}

func (a *API) uploadTerminalFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	ticket := r.Header.Get("X-Tessera-Transfer")
	snapshot, ok := a.fileTicket(w, r, ticket)
	if !ok {
		return
	}
	index, err := strconv.Atoi(r.URL.Query().Get("index"))
	if err != nil || index < 0 || index >= len(snapshot.Files) || snapshot.Operation != "upload" {
		writeError(w, 400, "invalid file index")
		return
	}
	t, err := a.Terminals.Files.Begin(ticket, "upload", index)
	if err != nil {
		writeError(w, 409, err.Error())
		return
	}
	defer a.Terminals.Files.Pause(ticket)
	restore := transferCancellation(w, t.Context)
	defer restore()
	file := t.Files[index]
	copy := r.Clone(t.Context)
	copy.URL = &url.URL{RawQuery: url.Values{"directory": {t.Directory}, "name": {file.Name}, "overwrite": {r.URL.Query().Get("overwrite")}}.Encode()}
	copy.Body = io.NopCloser(&transferReader{Reader: io.LimitReader(r.Body, file.Bytes+1), context: t.Context, progress: func(n int64) bool { return a.Terminals.Files.Progress(ticket, n) }, controller: http.NewResponseController(w)})
	// Require the announced length. The storage routine also verifies streamed
	// length, because an unknown/chunked body must not evade this contract.
	if r.ContentLength >= 0 && r.ContentLength != file.Bytes {
		writeError(w, 400, "upload size differs from selection")
		return
	}
	copy.ContentLength = file.Bytes
	outcome := &uploadOutcome{header: make(http.Header)}
	a.uploadFile(outcome, copy)
	if outcome.status == http.StatusCreated {
		var result struct {
			Path  string `json:"path"`
			Bytes int64  `json:"bytes"`
		}
		_ = json.Unmarshal(outcome.body, &result)
		file.Path, file.Bytes, file.Status = result.Path, result.Bytes, "uploaded"
		if err := a.Terminals.Files.Record(ticket, index, file); err != nil {
			writeError(w, 410, err.Error())
			return
		}
	}
	for name, values := range outcome.header {
		w.Header()[name] = values
	}
	w.WriteHeader(outcome.status)
	_, _ = w.Write(outcome.body)
}
func (a *API) terminalFileResult(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var req struct {
		Ticket string `json:"ticket"`
		Index  int    `json:"index"`
		Status string `json:"status"`
		Error  string `json:"error"`
	}
	if decodeFileControl(r, 8192, &req) != nil {
		writeError(w, 400, "invalid result")
		return
	}
	t, ok := a.fileTicket(w, r, req.Ticket)
	if !ok {
		return
	}
	if req.Index < 0 || req.Index >= len(t.Files) || t.Operation != "upload" || (req.Status != "skipped" && req.Status != "failed") {
		writeError(w, 400, "invalid file result")
		return
	}
	file := t.Files[req.Index]
	file.Status = req.Status
	file.Error = req.Error
	if err := a.Terminals.Files.Record(req.Ticket, req.Index, file); err != nil {
		writeError(w, 409, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (a *API) finishTerminalFiles(w http.ResponseWriter, r *http.Request) {
	a.finishFileRequest(w, r, false)
}
func (a *API) cancelTerminalFiles(w http.ResponseWriter, r *http.Request) {
	a.finishFileRequest(w, r, true)
}
func (a *API) finishFileRequest(w http.ResponseWriter, r *http.Request, cancel bool) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var req struct {
		Ticket string `json:"ticket"`
	}
	if decodeFileControl(r, 1024, &req) != nil {
		writeError(w, 400, "invalid ticket")
		return
	}
	t, ok := a.fileTicket(w, r, req.Ticket)
	if !ok {
		return
	}
	state := "complete"
	if cancel {
		state = "cancelled"
	} else if t.Operation != "upload" {
		writeError(w, 400, "downloads finish on the server")
		return
	}
	if err := a.Terminals.Files.Finish(req.Ticket, state, ""); err != nil {
		writeError(w, 409, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (a *API) downloadTerminalFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	if r.ParseForm() != nil {
		writeError(w, 400, "invalid download request")
		return
	}
	ticket := r.PostForm.Get("ticket")
	_, ok := a.fileTicket(w, r, ticket)
	if !ok {
		return
	}
	t, err := a.Terminals.Files.Begin(ticket, "download")
	if err != nil {
		writeError(w, 409, err.Error())
		return
	}
	restore := transferCancellation(w, t.Context)
	defer restore()
	files := make([]*os.File, 0, len(t.Paths))
	defer func() {
		for _, f := range files {
			_ = f.Close()
		}
	}()
	for i, path := range t.Paths {
		f, e := os.Open(path)
		if e == nil {
			var info os.FileInfo
			info, e = f.Stat()
			if e == nil && (!info.Mode().IsRegular() || info.Size() != t.Files[i].Bytes) {
				e = errors.New("download source changed or is not a regular file")
			}
		}
		if e != nil {
			if f != nil {
				_ = f.Close()
			}
			_ = a.Terminals.Files.Finish(ticket, "failed", e.Error())
			writeError(w, 400, e.Error())
			return
		}
		files = append(files, f)
	}
	name := t.Files[0].Name
	if len(files) > 1 {
		name = "tessera-files-" + t.ID + ".zip"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	writer := &transferWriter{Writer: w, context: t.Context, progress: func(n int64) bool { return a.Terminals.Files.Progress(ticket, n) }, controller: http.NewResponseController(w)}
	if len(files) == 1 {
		w.Header().Set("Content-Length", strconv.FormatInt(t.Files[0].Bytes, 10))
		_, err = io.CopyN(writer, files[0], t.Files[0].Bytes)
	} else {
		archive := zip.NewWriter(writer)
		for i, file := range files {
			var entry io.Writer
			entry, err = archive.CreateHeader(&zip.FileHeader{Name: t.Files[i].Name, Method: zip.Store})
			if err != nil {
				break
			}
			_, err = io.CopyN(entry, file, t.Files[i].Bytes)
			if err != nil {
				break
			}
		}
		if err == nil {
			err = archive.Close()
		}
	}
	if err != nil {
		restore()
		_ = a.Terminals.Files.Finish(ticket, "failed", "download interrupted")
	} else {
		// Successful completion cancels the ticket. Stop its IO interrupt
		// first so the HTTP server can still flush a buffered response.
		restore()
		_ = a.Terminals.Files.Finish(ticket, "sent", "")
	}
}
