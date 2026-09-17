package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"tessera/internal/localhttps"
	"tessera/internal/store"
)

func TestLocalHTTPSSettingsAPIValidatesPersistsAndRequestsRestart(t *testing.T) {
	directory := t.TempDir()
	st, err := store.Open(context.Background(), filepath.Join(directory, "tessera.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	restarted := make(chan struct{}, 1)
	api := &API{
		Store:               st,
		HTTPSDefaultAddress: "127.0.0.1:7331",
		HTTPSPKIDir:         filepath.Join(directory, "pki"),
		RequestRestart:      func(localhttps.Config) { restarted <- struct{}{} },
	}
	mux := http.NewServeMux()
	api.Register(mux)

	invalid := localhttps.Config{Enabled: true, HTTPSAddress: "bad"}
	response := requestLocalHTTPS(t, mux, invalid)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid status = %d, body = %s", response.Code, response.Body.String())
	}

	config := localhttps.Config{
		Enabled: true, HTTPSAddress: "127.0.0.1:7443",
		DNSNames: []string{"localhost"}, IPAddresses: []string{"127.0.0.1"},
	}
	response = requestLocalHTTPS(t, mux, config)
	if response.Code != http.StatusOK {
		t.Fatalf("save status = %d, body = %s", response.Code, response.Body.String())
	}
	var saved localHTTPSResponse
	if err := json.Unmarshal(response.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if !saved.Restarting || !saved.HasCA || saved.Fingerprint == "" || saved.RootName != localhttps.RootCommonName() || saved.EnrollmentURL == "" {
		t.Fatalf("saved response = %+v", saved)
	}
	select {
	case <-restarted:
	case <-time.After(time.Second):
		t.Fatal("restart was not requested")
	}

	get := httptest.NewRecorder()
	mux.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/api/host/https", nil))
	if get.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", get.Code, get.Body.String())
	}
	var loaded localHTTPSResponse
	if err := json.Unmarshal(get.Body.Bytes(), &loaded); err != nil {
		t.Fatal(err)
	}
	if loaded.Config.HTTPSAddress != config.HTTPSAddress || !loaded.HasCA {
		t.Fatalf("loaded response = %+v", loaded)
	}

	enrollment := httptest.NewRecorder()
	mux.ServeHTTP(enrollment, httptest.NewRequest(http.MethodGet, "/local-https/", nil))
	if enrollment.Code != http.StatusOK || !bytes.Contains(enrollment.Body.Bytes(), []byte("Download Tessera CA")) {
		t.Fatalf("enrollment response = %d, %s", enrollment.Code, enrollment.Body.String())
	}
	enrollmentRoot := httptest.NewRecorder()
	mux.ServeHTTP(enrollmentRoot, httptest.NewRequest(http.MethodGet, "/local-https/tessera-local-ca.crt", nil))
	if enrollmentRoot.Code != http.StatusOK || !bytes.Contains(enrollmentRoot.Body.Bytes(), []byte("BEGIN CERTIFICATE")) {
		t.Fatalf("enrollment root response = %d, %s", enrollmentRoot.Code, enrollmentRoot.Body.String())
	}

	root := httptest.NewRecorder()
	mux.ServeHTTP(root, httptest.NewRequest(http.MethodGet, "/api/host/https/ca", nil))
	if root.Code != http.StatusOK || !bytes.Contains(root.Body.Bytes(), []byte("BEGIN CERTIFICATE")) {
		t.Fatalf("root response = %d, %s", root.Code, root.Body.String())
	}
}

func requestLocalHTTPS(t *testing.T, handler http.Handler, config localhttps.Config) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	if err := json.NewEncoder(&body).Encode(config); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPut, "/api/host/https", &body)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
