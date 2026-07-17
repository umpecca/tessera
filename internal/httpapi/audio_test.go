package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"tessera/internal/audio"
)

func TestAudioFileAPIAndRanges(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sample.mp3")
	content := []byte("ID3-0123456789")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	manager := audio.NewManager(nil, nil, audio.Options{})
	defer manager.Close()
	server := newAudioTestServer(manager)
	defer server.Close()

	body, _ := json.Marshal(map[string]string{"kind": "file", "value": path})
	response, err := http.DefaultClient.Do(mustRequest(t, http.MethodPut, server.URL+"/api/audio/source", bytes.NewReader(body)))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("set source status = %d", response.StatusCode)
	}
	var state audio.State
	if err := json.NewDecoder(response.Body).Decode(&state); err != nil {
		t.Fatal(err)
	}

	request := mustRequest(t, http.MethodGet, server.URL+"/api/audio/stream?sourceVersion="+strconv.FormatUint(state.SourceVersion, 10), nil)
	request.Header.Set("Range", "bytes=4-7")
	stream, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	got, _ := io.ReadAll(stream.Body)
	if stream.StatusCode != http.StatusPartialContent || string(got) != string(content[4:8]) {
		t.Fatalf("range response = %d %q", stream.StatusCode, got)
	}
	if stream.Header.Get("Content-Type") != "audio/mpeg" {
		t.Fatalf("content type = %q", stream.Header.Get("Content-Type"))
	}

	stale, err := http.Get(server.URL + "/api/audio/stream?sourceVersion=" + strconv.FormatUint(state.SourceVersion+1, 10))
	if err != nil {
		t.Fatal(err)
	}
	defer stale.Body.Close()
	if stale.StatusCode != http.StatusConflict {
		t.Fatalf("stale stream status = %d", stale.StatusCode)
	}
}

func TestAudioURLProxyAndControl(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/ogg")
		w.Header().Set("Icy-Name", "Test Radio")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("stream-data"))
	}))
	defer upstream.Close()
	manager := audio.NewManager(nil, nil, audio.Options{})
	defer manager.Close()
	server := newAudioTestServer(manager)
	defer server.Close()

	setBody, _ := json.Marshal(map[string]string{"kind": "url", "value": upstream.URL + "/radio.ogg"})
	response, err := http.DefaultClient.Do(mustRequest(t, http.MethodPut, server.URL+"/api/audio/source", bytes.NewReader(setBody)))
	if err != nil {
		t.Fatal(err)
	}
	var state audio.State
	if err := json.NewDecoder(response.Body).Decode(&state); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()

	playBody := bytes.NewBufferString(`{"action":"play"}`)
	play, err := http.DefaultClient.Do(mustRequest(t, http.MethodPost, server.URL+"/api/audio/control", playBody))
	if err != nil {
		t.Fatal(err)
	}
	if play.StatusCode != http.StatusOK {
		t.Fatalf("play status = %d", play.StatusCode)
	}
	play.Body.Close()

	proxied, err := http.Get(server.URL + "/api/audio/stream?sourceVersion=" + strconv.FormatUint(state.SourceVersion, 10))
	if err != nil {
		t.Fatal(err)
	}
	defer proxied.Body.Close()
	got, _ := io.ReadAll(proxied.Body)
	if string(got) != "stream-data" || proxied.Header.Get("Icy-Name") != "Test Radio" {
		t.Fatalf("proxy response = %q headers=%v", got, proxied.Header)
	}
}

func newAudioTestServer(manager *audio.Manager) *httptest.Server {
	mux := http.NewServeMux()
	(&API{Audio: manager}).Register(mux)
	return httptest.NewServer(mux)
}

func mustRequest(t *testing.T, method, url string, body io.Reader) *http.Request {
	t.Helper()
	request, err := http.NewRequestWithContext(context.Background(), method, url, body)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	return request
}
