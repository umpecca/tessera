package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tessera/internal/store"
	"tessera/internal/terminal"
	"tessera/internal/terminalfile"
)

type cancelUploadReader struct{ read func([]byte) (int, error) }

func (r cancelUploadReader) Read(p []byte) (int, error) { return r.read(p) }

func TestCancellationDuringBodyLeavesNoPartialFile(t *testing.T) {
	api, b := fileAPI(t)
	directory := t.TempDir()
	ticket := fileOffer(t, b, terminalfile.Command{Action: "upload", ID: "id", Directory: directory}, []terminalfile.File{{Name: "file", Bytes: 3}})
	body := cancelUploadReader{read: func(p []byte) (int, error) {
		copy(p, "abc")
		b.CancelSession("default", "pane", "epoch")
		return 3, nil
	}}
	r := httptest.NewRequest("POST", "/api/terminal-files/upload?index=0", body)
	r.ContentLength = 3
	r.Header.Set("X-Tessera-Transfer", ticket)
	w := httptest.NewRecorder()
	api.uploadTerminalFile(w, r)
	if w.Code == 201 {
		t.Fatal("cancelled transfer committed")
	}
	if _, err := os.Stat(filepath.Join(directory, "file")); !os.IsNotExist(err) {
		t.Fatal("partial file remains")
	}
	assertNoTransferTemporaryFiles(t, directory)
}

func TestDownloadTargetKeepsMainAppOriginProtections(t *testing.T) {
	api, _ := fileAPI(t)
	w := httptest.NewRecorder()
	api.terminalFileFrame(w, httptest.NewRequest("GET", "/api/terminal-files/frame", nil))
	if w.Header().Get("X-Frame-Options") != "SAMEORIGIN" || w.Header().Get("Referrer-Policy") != "same-origin" || strings.Contains(w.Body.String(), "script") {
		t.Fatal("unsafe download target")
	}
	if !strings.Contains(securityCSP, "frame-ancestors 'none'") {
		t.Fatal("main app frame policy changed")
	}
}

func fileAPI(t *testing.T) (*API, *terminalfile.Broker) {
	t.Helper()
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "db.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	manager := terminal.NewManager()
	t.Cleanup(manager.Close)
	return &API{Store: st, Terminals: manager}, manager.Files
}
func fileOffer(t *testing.T, b *terminalfile.Broker, c terminalfile.Command, selected []terminalfile.File) string {
	t.Helper()
	events := make(chan terminalfile.Event, 16)
	b.Register("default", "pane", "epoch", "client", "g", func(e terminalfile.Event) { events <- e })
	b.Handle("default", "pane", "epoch", c, func(string) {})
	select {
	case e := <-events:
		if e.Action != "request" {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Fatal("no offer")
	}
	ticket, err := b.Claim("default", "pane", "epoch", c.ID, "client", selected)
	if err != nil {
		t.Fatal(err)
	}
	return ticket
}
func sendFileUpload(api *API, ticket string, index int, body []byte, overwrite bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/api/terminal-files/upload?index="+string(rune('0'+index))+"&overwrite="+map[bool]string{false: "0", true: "1"}[overwrite], bytes.NewReader(body))
	req.Header.Set("X-Tessera-Transfer", ticket)
	w := httptest.NewRecorder()
	api.uploadTerminalFile(w, req)
	return w
}
func TestTicketUploadBatchConflictOverwriteAndReplay(t *testing.T) {
	api, b := fileAPI(t)
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "one.txt"), []byte("old"), 0600)
	ticket := fileOffer(t, b, terminalfile.Command{Action: "upload", ID: "upload", Directory: dir}, []terminalfile.File{{Name: "one.txt", Bytes: 3}, {Name: "ü.txt", Bytes: 0}})
	if w := sendFileUpload(api, ticket, 0, []byte("new"), false); w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := sendFileUpload(api, ticket, 0, []byte("new"), true); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := sendFileUpload(api, ticket, 0, []byte("new"), true); w.Code != 409 {
		t.Fatal("replayed upload", w.Code)
	}
	if w := sendFileUpload(api, ticket, 1, nil, false); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	if err := b.Finish(ticket, "complete", ""); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "one.txt"))
	if string(got) != "new" {
		t.Fatal(string(got))
	}
	assertNoTransferTemporaryFiles(t, dir)
	if w := sendFileUpload(api, ticket, 0, []byte("new"), true); w.Code != 410 {
		t.Fatal("expired ticket usable")
	}
}
func TestTicketUploadRejectsMismatchedLengthAndCancelledBody(t *testing.T) {
	api, b := fileAPI(t)
	dir := t.TempDir()
	ticket := fileOffer(t, b, terminalfile.Command{Action: "upload", ID: "upload", Directory: dir}, []terminalfile.File{{Name: "one", Bytes: 3}})
	if w := sendFileUpload(api, ticket, 0, []byte("long"), false); w.Code != 400 {
		t.Fatal(w.Code)
	}
	req := httptest.NewRequest("POST", "/api/terminal-files/upload?index=0", strings.NewReader("x"))
	req.ContentLength = -1
	req.Header.Set("X-Tessera-Transfer", ticket)
	w := httptest.NewRecorder()
	api.uploadTerminalFile(w, req)
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
	if _, err := os.Stat(filepath.Join(dir, "one")); !os.IsNotExist(err) {
		t.Fatal("partial upload committed")
	}
	assertNoTransferTemporaryFiles(t, dir)
	b.CancelSession("default", "pane", "epoch")
	if w := sendFileUpload(api, ticket, 0, []byte("abc"), false); w.Code != 410 {
		t.Fatal(w.Code)
	}
}
func TestTicketDownloadsOriginalAndStreamedZIP(t *testing.T) {
	for _, count := range []int{1, 2} {
		t.Run(string(rune('0'+count)), func(t *testing.T) {
			api, b := fileAPI(t)
			dir := t.TempDir()
			paths := []string{}
			for _, name := range []string{"one.txt", "ü.txt"}[:count] {
				p := filepath.Join(dir, name)
				_ = os.WriteFile(p, []byte(name), 0600)
				paths = append(paths, p)
			}
			ticket := fileOffer(t, b, terminalfile.Command{Action: "download", ID: "download", Paths: paths}, nil)
			req := httptest.NewRequest("POST", "/api/terminal-files/download", strings.NewReader(url.Values{"ticket": {ticket}}.Encode()))
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			w := httptest.NewRecorder()
			api.downloadTerminalFiles(w, req)
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			if count == 1 {
				if w.Body.String() != "one.txt" || !strings.Contains(w.Header().Get("Content-Disposition"), "one.txt") {
					t.Fatal(w.Body.String())
				}
			} else {
				archive, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
				if err != nil {
					t.Fatal(err)
				}
				if len(archive.File) != 2 {
					t.Fatal(len(archive.File))
				}
				for _, file := range archive.File {
					r, err := file.Open()
					if err != nil {
						t.Fatal(err)
					}
					data, _ := io.ReadAll(r)
					_ = r.Close()
					if string(data) != file.Name || file.Method != zip.Store {
						t.Fatal(file.Name)
					}
				}
			}
			if _, ok := b.Lookup(ticket); ok {
				t.Fatal("successful download ticket retained")
			}
		})
	}
}
func TestClaimEndpointAndRetiredRoutes(t *testing.T) {
	api, b := fileAPI(t)
	events := make(chan terminalfile.Event, 8)
	b.Register("default", "pane", "epoch", "client", "g", func(e terminalfile.Event) { events <- e })
	b.Handle("default", "pane", "epoch", terminalfile.Command{Action: "upload", ID: "id", Directory: t.TempDir()}, func(string) {})
	select {
	case <-events:
	case <-time.After(time.Second):
		t.Fatal("no offer")
	}
	body, _ := json.Marshal(map[string]any{"workspaceId": "default", "paneId": "pane", "epoch": "epoch", "clientId": "client", "id": "id", "files": []terminalfile.File{{Name: "a", Bytes: 1}}})
	w := httptest.NewRecorder()
	api.claimTerminalFiles(w, httptest.NewRequest("POST", "/api/terminal-files/claim", bytes.NewReader(body)))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	mux := http.NewServeMux()
	api.Register(mux)
	for _, path := range []string{"/api/files", "/api/files/upload", "/api/files/download"} {
		r := httptest.NewRecorder()
		mux.ServeHTTP(r, httptest.NewRequest("POST", path, nil))
		if r.Code != 404 {
			t.Fatalf("retired route %s: %d", path, r.Code)
		}
	}
}
