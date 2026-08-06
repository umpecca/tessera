package httpapi

import (
	"bufio"
	"compress/gzip"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func compressed(t *testing.T, handler http.Handler, target string, header http.Header) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, target, nil)
	request.Header.Set("Accept-Encoding", "gzip, deflate, br")
	for name, values := range header {
		request.Header[name] = values
	}
	response := httptest.NewRecorder()
	NewCompressionHandler(handler).ServeHTTP(response, request)
	return response
}

func serving(contentType, body string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", contentType)
		_, _ = io.WriteString(w, body)
	})
}

func gunzip(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	reader, err := gzip.NewReader(response.Body)
	if err != nil {
		t.Fatalf("response was not valid gzip: %v", err)
	}
	defer reader.Close()
	body, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("reading gzip body: %v", err)
	}
	return string(body)
}

func TestTextResponsesAreCompressedAndStillDecodeToTheOriginal(t *testing.T) {
	body := strings.Repeat("function terminalStatusBadge(rect) { return rect; }\n", 200)
	response := compressed(t, serving("text/javascript; charset=utf-8", body), "/app.js", nil)

	if got := response.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := gunzip(t, response); got != body {
		t.Fatalf("decompressed body differs from the original (%d vs %d bytes)", len(got), len(body))
	}
	if response.Body.Len() >= len(body) {
		t.Fatalf("compressed size %d did not beat %d", response.Body.Len(), len(body))
	}
	if !strings.Contains(response.Header().Get("Vary"), "Accept-Encoding") {
		t.Fatal("a response that varies by encoding did not say so")
	}
}

func TestJSONResponsesAreCompressed(t *testing.T) {
	body := `{"panes":[` + strings.Repeat(`{"id":"pane-1","kind":"terminal"},`, 100) + `{}]}`
	response := compressed(t, serving("application/json", body), "/api/workspace/x", nil)
	if got := response.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := gunzip(t, response); got != body {
		t.Fatal("decompressed JSON differs from the original")
	}
}

func TestAClientThatDidNotAskForGzipGetsIdentity(t *testing.T) {
	body := strings.Repeat("plain text\n", 200)
	request := httptest.NewRequest(http.MethodGet, "/app.js", nil)
	response := httptest.NewRecorder()
	NewCompressionHandler(serving("text/javascript", body)).ServeHTTP(response, request)

	if got := response.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want none", got)
	}
	if response.Body.String() != body {
		t.Fatal("identity response was altered")
	}
}

// Fonts, images and audio are already compressed; gzip would only add bytes.
func TestAlreadyCompressedTypesArePassedThrough(t *testing.T) {
	for _, contentType := range []string{"font/woff2", "image/png", "audio/mpeg", "application/octet-stream"} {
		body := strings.Repeat("\x00\x01\x02\x03", 500)
		response := compressed(t, serving(contentType, body), "/assets/thing", nil)
		if got := response.Header().Get("Content-Encoding"); got != "" {
			t.Fatalf("%s was compressed (Content-Encoding %q)", contentType, got)
		}
		if response.Body.String() != body {
			t.Fatalf("%s body was altered", contentType)
		}
	}
}

// Compressing an event stream would hold events in a buffer until enough
// accumulated, which is the one thing an event stream must not do.
func TestServerSentEventsAreNeverCompressed(t *testing.T) {
	var flushes int
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for i := 0; i < 3; i++ {
			_, _ = io.WriteString(w, "data: audio update\n\n")
			flusher, ok := w.(http.Flusher)
			if !ok {
				t.Fatal("event stream handler lost its Flusher")
			}
			flusher.Flush()
			flushes++
		}
	})
	response := compressed(t, handler, "/api/audio/events", nil)

	if got := response.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("event stream was compressed (Content-Encoding %q)", got)
	}
	if flushes != 3 || !strings.Contains(response.Body.String(), "data: audio update") {
		t.Fatalf("event stream did not pass through: %d flushes, body %q", flushes, response.Body.String())
	}
}

// The terminal websocket takes over the connection. If the wrapper does not
// offer Hijack, the upgrade fails and every terminal in the app stops working.
func TestAHijackedConnectionReachesTheUnderlyingWriter(t *testing.T) {
	var hijacked bool
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			t.Fatal("websocket handler could not hijack through the compression wrapper")
		}
		if _, _, err := hijacker.Hijack(); err == nil {
			hijacked = true
		}
	})
	request := httptest.NewRequest(http.MethodGet, "/api/terminal", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	NewCompressionHandler(handler).ServeHTTP(hijackableRecorder{httptest.NewRecorder()}, request)

	if !hijacked {
		t.Fatal("Hijack did not reach the underlying writer")
	}
}

// An upgrade request never carries a compressible response at all.
func TestUpgradeRequestsBypassTheWrapperEntirely(t *testing.T) {
	var plain bool
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, plain = w.(*compressResponseWriter)
	})
	request := httptest.NewRequest(http.MethodGet, "/api/terminal", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	request.Header.Set("Upgrade", "websocket")
	NewCompressionHandler(handler).ServeHTTP(httptest.NewRecorder(), request)

	if plain {
		t.Fatal("an upgrade request was wrapped for compression")
	}
}

// Compressed and identity bytes are different representations, so a cache
// must not be able to confuse their validators.
func TestCompressedResponsesCarryTheirOwnValidator(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/css")
		w.Header().Set("ETag", `"abc123"`)
		_, _ = io.WriteString(w, strings.Repeat(".pane { color: red }\n", 100))
	})
	response := compressed(t, handler, "/styles.css", nil)

	if got, want := response.Header().Get("ETag"), `"abc123-gzip"`; got != want {
		t.Fatalf("ETag = %q, want %q", got, want)
	}
}

// The suffix has to come back off, or the handler underneath would compare
// it against its own tag, never match, and resend the whole body every time.
func TestARevalidationWithTheCompressedValidatorStillMatches(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/css")
		w.Header().Set("ETag", `"abc123"`)
		if r.Header.Get("If-None-Match") == `"abc123"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		_, _ = io.WriteString(w, strings.Repeat(".pane { color: red }\n", 100))
	})
	response := compressed(t, handler, "/styles.css", http.Header{
		"If-None-Match": []string{`"abc123-gzip"`},
	})

	if response.Code != http.StatusNotModified {
		t.Fatalf("status = %d, want 304 for an unchanged compressed asset", response.Code)
	}
	if got, want := response.Header().Get("ETag"), `"abc123-gzip"`; got != want {
		t.Fatalf("ETag on the 304 = %q, want %q", got, want)
	}
}

func TestSmallResponsesAreLeftAlone(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", "18")
		_, _ = io.WriteString(w, `{"users":["alice"]}`[:18])
	})
	response := compressed(t, handler, "/api/users", nil)
	if got := response.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("a tiny response was compressed (%q)", got)
	}
}

type hijackableRecorder struct{ *httptest.ResponseRecorder }

func (hijackableRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	client, server := net.Pipe()
	go func() { _ = server.Close() }()
	return client, bufio.NewReadWriter(bufio.NewReader(client), bufio.NewWriter(client)), nil
}
