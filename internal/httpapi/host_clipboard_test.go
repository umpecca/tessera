package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"

	"tessera/internal/hostclipboard"
)

func stubHostClipboard(t *testing.T, status hostclipboard.Status, write func(hostclipboard.Image) error) {
	t.Helper()
	detect, writer := detectHostClipboard, writeHostClipboard
	t.Cleanup(func() { detectHostClipboard, writeHostClipboard = detect, writer })
	detectHostClipboard = func() hostclipboard.Status { return status }
	writeHostClipboard = func(_ context.Context, img hostclipboard.Image) error { return write(img) }
}

func hostClipboardRequest(t *testing.T, api *API, method string, body []byte) (*httptest.ResponseRecorder, hostClipboardResponse) {
	t.Helper()
	mux := http.NewServeMux()
	api.Register(mux)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(method, "/api/host/clipboard", bytes.NewReader(body)))
	var decoded hostClipboardResponse
	_ = json.Unmarshal(response.Body.Bytes(), &decoded)
	return response, decoded
}

func pngBytes(t *testing.T) []byte {
	t.Helper()
	var out bytes.Buffer
	if err := png.Encode(&out, image.NewNRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestHostClipboardWritesAPastedImageAndReportsIt(t *testing.T) {
	var written hostclipboard.Image
	stubHostClipboard(t, hostclipboard.Status{Available: true, Backend: "test", Session: hostclipboard.SessionDesktop},
		func(img hostclipboard.Image) error { written = img; return nil })
	api := &API{}

	response, status := hostClipboardRequest(t, api, http.MethodGet, nil)
	if response.Code != http.StatusOK || !status.Available || status.LastWrite != nil {
		t.Fatalf("before: %d %+v", response.Code, status)
	}
	response, status = hostClipboardRequest(t, api, http.MethodPost, pngBytes(t))
	if response.Code != http.StatusOK || written.MIME != "image/png" || status.LastWrite == nil || !status.LastWrite.OK {
		t.Fatalf("write: %d %s", response.Code, response.Body.String())
	}
	if _, status = hostClipboardRequest(t, api, http.MethodGet, nil); status.LastWrite == nil || !status.LastWrite.OK {
		t.Fatalf("after: %+v", status)
	}
}

func TestHostClipboardRejectsDataThatIsNotAnImage(t *testing.T) {
	stubHostClipboard(t, hostclipboard.Status{Available: true, Session: hostclipboard.SessionDesktop},
		func(hostclipboard.Image) error { t.Fatal("wrote non-image data"); return nil })
	response, _ := hostClipboardRequest(t, &API{}, http.MethodPost, []byte("#!/bin/sh\n"))
	if response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status %d", response.Code)
	}
}

func TestHostClipboardExplainsWhyItIsUnavailable(t *testing.T) {
	unavailable := hostclipboard.Status{Session: hostclipboard.SessionService, Reason: "running as a service"}
	stubHostClipboard(t, unavailable, func(hostclipboard.Image) error {
		return errors.Join(hostclipboard.ErrUnavailable, errors.New("running as a service"))
	})
	api := &API{}
	response, status := hostClipboardRequest(t, api, http.MethodPost, pngBytes(t))
	if response.Code != http.StatusServiceUnavailable || status.Available || status.Reason != "running as a service" {
		t.Fatalf("%d %+v", response.Code, status)
	}
	if status.LastWrite == nil || status.LastWrite.OK || status.LastWrite.Error == "" {
		t.Fatalf("last write %+v", status.LastWrite)
	}
}
