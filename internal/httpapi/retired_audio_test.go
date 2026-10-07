package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRetiredAudioRoutesReturnNotFound(t *testing.T) {
	mux := http.NewServeMux()
	(&API{WebFS: testWebFS("test")}).Register(mux)
	for _, route := range []string{"state", "source", "control", "events", "stream"} {
		for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodPost, http.MethodHead} {
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, httptest.NewRequest(method, "/api/audio/"+route, strings.NewReader(`{}`)))
			if response.Code != http.StatusNotFound {
				t.Fatalf("%s %s: status %d", method, route, response.Code)
			}
		}
	}
}
