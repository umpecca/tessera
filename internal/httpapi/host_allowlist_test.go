package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"tessera/internal/localhttps"
	"tessera/internal/store"
)

func TestHostAllowlist(t *testing.T) {
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	config := localhttps.DefaultConfig("127.0.0.1:7331")
	config.DNSNames = append(config.DNSNames, "tessera.lan")
	if err := st.SaveLocalHTTPSConfig(context.Background(), config); err != nil {
		t.Fatal(err)
	}
	handler := NewSecurityHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }),
		st, SecurityOptions{ConnectionLog: io.Discard, AllowedHosts: []string{"Box.Tail1234.TS.net"}, DefaultAddress: "127.0.0.1:7331"})
	hostname, _ := os.Hostname()
	short := strings.TrimSuffix(strings.ToLower(hostname), ".local")
	for host, want := range map[string]int{
		"127.0.0.1:7331": 204, "[::1]:7331": 204, "100.125.47.118:6969": 204, "192.168.0.38": 204,
		"localhost:7331": 204, "app.localhost": 204, short + ":7331": 204, short + ".local": 204,
		"box.tail1234.ts.net": 204, "BOX.tail1234.ts.net.:443": 204, "tessera.lan": 204,
		"attacker.example": 421, "127.0.0.1.attacker.example": 421, "tessera.lan.evil": 421,
	} {
		request := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		request.Host = host
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != want {
			t.Errorf("Host %q = %d, want %d", host, recorder.Code, want)
		}
		if want == 421 && !strings.Contains(recorder.Body.String(), "-allowed-host") {
			t.Errorf("Host %q refusal does not name the flag", host)
		}
	}
}
