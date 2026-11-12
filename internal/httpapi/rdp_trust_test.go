package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tessera/internal/store"
	"tessera/web"
)

func trustRDPRequest(api *API, workspace, account, target, fingerprint, previous string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"workspaceId": workspace, "target": target, "fingerprint": fingerprint, "previousFingerprint": previous})
	request := httptest.NewRequest(http.MethodPost, "/api/rdp-proxy/trust", strings.NewReader(string(body)))
	if account != "" {
		request = request.WithContext(context.WithValue(request.Context(), signInKey{}, store.SignIn{Account: account}))
	}
	response := httptest.NewRecorder()
	api.rdpTrustCertificate(response, request)
	return response
}

func TestRDPCertificateTrustAPIValidationNormalizationAndConflicts(t *testing.T) {
	api := rdpTestAPI(t)
	a, b := strings.Repeat("ab", 32), strings.Repeat("cd", 32)
	response := trustRDPRequest(api, "default", "", "rdp://HOST.local", strings.Repeat("AB:", 31)+"AB", "")
	if response.Code != http.StatusOK {
		t.Fatalf("approval = %d: %s", response.Code, response.Body.String())
	}
	if got, err := api.Store.RDPCertificateFingerprint(context.Background(), "default", "host.local:3389"); err != nil || got != a {
		t.Fatalf("normalized saved trust = %q, %v", got, err)
	}
	for _, tc := range []struct {
		target, next, previous string
		want                   int
	}{
		{"host.local:3389", a, "", http.StatusOK},
		{"host.local", b, "", http.StatusConflict},
		{"HOST.local", b, a, http.StatusOK},
		{"host.local", a, a, http.StatusConflict},
		{"host.local:3390", a, "", http.StatusOK},
		{"[2001:0db8:0:0:0:0:0:1]", a, "", http.StatusOK},
		{"host.local", "abcd", "", http.StatusBadRequest},
		{"host.local", a, "bad", http.StatusBadRequest},
		{"host.local", strings.Repeat("z", 64), "", http.StatusBadRequest},
		{"rdp://user:password@host.local", a, "", http.StatusBadRequest},
		{"http://host.local", a, "", http.StatusBadRequest},
		{"host.local:65536", a, "", http.StatusBadRequest},
	} {
		response := trustRDPRequest(api, "default", "", tc.target, tc.next, tc.previous)
		if response.Code != tc.want {
			t.Fatalf("%s approval: %d %s; want %d", tc.target, response.Code, response.Body.String(), tc.want)
		}
	}
	if got, _ := api.Store.RDPCertificateFingerprint(context.Background(), "default", "[2001:db8::1]:3389"); got != a {
		t.Fatalf("normalized IPv6 approval = %q", got)
	}
	for _, body := range []string{
		`{`, `{"target":"host.local","fingerprint":"` + a + `","userId":"bob"}`,
		`{"target":"host.local","fingerprint":"` + a + `","password":"secret"}`,
		`{"target":"host.local","fingerprint":"` + a + `"} {}`,
		`{"target":"` + strings.Repeat("x", 4096) + `","fingerprint":"` + a + `"}`,
	} {
		response := httptest.NewRecorder()
		api.rdpTrustCertificate(response, httptest.NewRequest(http.MethodPost, "/api/rdp-proxy/trust", strings.NewReader(body)))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid body status = %d", response.Code)
		}
	}
	response = httptest.NewRecorder()
	api.rdpTrustCertificate(response, httptest.NewRequest(http.MethodGet, "/api/rdp-proxy/trust", nil))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d", response.Code)
	}
}

func TestRDPCertificateTrustFollowsAuthenticatedAccountAndChecksWorkspace(t *testing.T) {
	api := rdpTestAPI(t)
	api.AuthMode = AuthFile
	fingerprint := strings.Repeat("ab", 32)
	ctx := context.Background()
	alice, err := api.Store.CreateSession(ctx, "alice", "Alice")
	if err != nil {
		t.Fatal(err)
	}
	bob, err := api.Store.CreateSession(ctx, "bob", "Bob")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		workspace, account string
		want               int
	}{
		{alice.ID, "alice", http.StatusOK}, {bob.ID, "alice", http.StatusNotFound},
		{alice.ID, "bob", http.StatusNotFound}, {alice.ID, "", http.StatusNotFound},
		{"missing", "alice", http.StatusNotFound},
	} {
		response := trustRDPRequest(api, tc.workspace, tc.account, "host.local", fingerprint, "")
		if response.Code != tc.want {
			t.Fatalf("%s/%s = %d %s; want %d", tc.account, tc.workspace, response.Code, response.Body.String(), tc.want)
		}
	}
	if got, _ := api.Store.RDPCertificateFingerprint(ctx, "bob", "host.local:3389"); got != "" {
		t.Fatalf("bob inherited alice trust: %q", got)
	}
	request := httptest.NewRequest(http.MethodPost, "/", nil)
	request = request.WithContext(context.WithValue(request.Context(), signInKey{}, store.SignIn{Account: "alice"}))
	if owner, legacy, err := api.rdpTrustOwner(request, alice.ID); err != nil || owner != "alice" || !legacy {
		t.Fatalf("own file-account legacy approval: %q, %v, %v", owner, legacy, err)
	}
	// System sign-in can share the default workspace. Its saved pane approval is
	// not evidence that another signed-in account accepted the same certificate.
	api.AuthMode = AuthSystem
	if owner, legacy, err := api.rdpTrustOwner(request, alice.ID); err != nil || owner != "alice" || legacy {
		t.Fatalf("system sign-in cannot identify a legacy pane's approving account: %q, %v, %v", owner, legacy, err)
	}
	if response := trustRDPRequest(api, "default", "alice", "shared.local", fingerprint, ""); response.Code != http.StatusOK {
		t.Fatalf("shared workspace approval = %d %s", response.Code, response.Body.String())
	}
	for _, account := range []string{"alice", "bob"} {
		request := httptest.NewRequest(http.MethodPost, "/", nil)
		request = request.WithContext(context.WithValue(request.Context(), signInKey{}, store.SignIn{Account: account}))
		owner, allowPaneTrust, err := api.rdpTrustOwner(request, "default")
		if err != nil || owner != account || allowPaneTrust {
			t.Fatalf("shared workspace trust owner = %q, legacy=%v, %v", owner, allowPaneTrust, err)
		}
	}
	if got, _ := api.Store.RDPCertificateFingerprint(ctx, "bob", "shared.local:3389"); got != "" {
		t.Fatal("system account inherited another account's trust")
	}
}

func TestRDPCertificateTrustRouteRejectsForeignOrigins(t *testing.T) {
	api := rdpTestAPI(t)
	mux := http.NewServeMux()
	api.Register(mux)
	handler := NewSecurityHandler(mux, nil, SecurityOptions{ConnectionLog: io.Discard})
	fingerprint := strings.Repeat("ab", 32)
	body := `{"workspaceId":"default","target":"host.local","fingerprint":"` + fingerprint + `"}`
	for _, tc := range []struct {
		origin string
		want   int
	}{
		{"http://evil.example", http.StatusForbidden},
		{"http://127.0.0.1:7331", http.StatusOK},
	} {
		request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:7331/api/rdp-proxy/trust", strings.NewReader(body))
		request.Header.Set("Origin", tc.origin)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != tc.want {
			t.Fatalf("origin %s: %d %s, want %d", tc.origin, response.Code, response.Body.String(), tc.want)
		}
		got, err := api.Store.RDPCertificateFingerprint(context.Background(), "default", "host.local:3389")
		if err != nil || (tc.want == http.StatusForbidden && got != "") || (tc.want == http.StatusOK && got != fingerprint) {
			t.Fatalf("origin %s stored %q, %v", tc.origin, got, err)
		}
	}
}

func TestRDPCertificateProbesDoNotExposeOtherAccountsTrust(t *testing.T) {
	api := rdpTestAPI(t)
	api.AuthMode = AuthSystem
	server := startFakeRDPServer(t, rdpNegotiationResponse(0x02, rdpProtocolSSL))
	fingerprint := rdpCertificateFingerprint(server.certificate.Raw)
	if response := trustRDPRequest(api, "default", "alice", server.address, fingerprint, ""); response.Code != http.StatusOK {
		t.Fatalf("approval = %d %s", response.Code, response.Body.String())
	}
	for _, account := range []string{"alice", "bob"} {
		body, _ := json.Marshal(map[string]string{"workspaceId": "default", "target": server.address})
		request := httptest.NewRequest(http.MethodPost, "/api/rdp-proxy/certificate", strings.NewReader(string(body)))
		request = request.WithContext(context.WithValue(request.Context(), signInKey{}, store.SignIn{Account: account}))
		response := httptest.NewRecorder()
		api.rdpProxyCertificate(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("probe = %d %s", response.Code, response.Body.String())
		}
		<-server.requests
		var data struct {
			TrustedFingerprint string
			AllowPaneTrust     bool
		}
		if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil {
			t.Fatal(err)
		}
		want := ""
		if account == "alice" {
			want = fingerprint
		}
		if data.TrustedFingerprint != want || data.AllowPaneTrust {
			t.Fatalf("%s probe = %+v, want pin %q and no legacy shared-pane approval", account, data, want)
		}
	}
}

func TestRDPCertificateProbeReturnsRememberedTrustWithoutLearningIt(t *testing.T) {
	server := startFakeRDPServer(t, rdpNegotiationResponse(0x02, rdpProtocolSSL))
	api := rdpTestAPI(t)
	fingerprint := rdpCertificateFingerprint(server.certificate.Raw)
	probe := func(workspace string) (string, string) {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"workspaceId": workspace, "target": server.address})
		response := httptest.NewRecorder()
		api.rdpProxyCertificate(response, httptest.NewRequest(http.MethodPost, "/api/rdp-proxy/certificate", strings.NewReader(string(body))))
		if response.Code != http.StatusOK {
			t.Fatalf("probe = %d %s", response.Code, response.Body.String())
		}
		<-server.requests
		var data struct {
			Fingerprint, TrustedFingerprint string
			AllowPaneTrust                  bool
		}
		if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil || !data.AllowPaneTrust {
			t.Fatalf("probe JSON: %+v, %v", data, err)
		}
		return data.Fingerprint, data.TrustedFingerprint
	}
	if presented, trusted := probe("default"); presented != fingerprint || trusted != "" {
		t.Fatalf("initial probe = %q, %q", presented, trusted)
	}
	if presented, trusted := probe("default"); presented != fingerprint || trusted != "" {
		t.Fatal("probing silently trusted the certificate")
	}
	response := trustRDPRequest(api, "default", "", server.address, fingerprint, "")
	if response.Code != http.StatusOK {
		t.Fatalf("approve = %d %s", response.Code, response.Body.String())
	}
	other, err := api.Store.CreateSession(context.Background(), "default", "Other")
	if err != nil {
		t.Fatal(err)
	}
	if presented, trusted := probe(other.ID); presented != fingerprint || trusted != fingerprint {
		t.Fatalf("new session probe = %q, %q", presented, trusted)
	}
	// A pin different from the presented leaf is returned, never replaced by the
	// probe. The UI must warn; actual RDP connections still compare leaf hashes.
	changed := strings.Repeat("00", 32)
	response = trustRDPRequest(api, "default", "", server.address, changed, fingerprint)
	if response.Code != http.StatusOK {
		t.Fatalf("change = %d %s", response.Code, response.Body.String())
	}
	if presented, trusted := probe(other.ID); presented != fingerprint || trusted != changed {
		t.Fatalf("changed probe = %q, %q", presented, trusted)
	}
}

// Exercises the embedded application, real certificate dialogs and real
// X.224/TLS probes. The upstream fixture does not implement RDP login/graphics.
func TestRememberedRDPCertificateTrustInBrowsers(t *testing.T) {
	playwright := os.Getenv("TESSERA_PLAYWRIGHT")
	if playwright == "" {
		t.Skip("set TESSERA_PLAYWRIGHT to run the Chromium/WebKit certificate trust check")
	}
	api := rdpTestAPI(t)
	api.WebFS = web.Files
	upstreams := map[string]*fakeRDPServer{}
	configs := map[string]map[string]string{}
	replacement := startFakeRDPServer(t, rdpNegotiationResponse(0x02, rdpProtocolSSL))
	for _, engine := range []string{"chromium", "webkit"} {
		upstream := startFakeRDPServer(t, rdpNegotiationResponse(0x02, rdpProtocolSSL))
		upstreams[engine] = upstream
		urls := []string{}
		for _, name := range []string{engine, engine + "-other"} {
			session, err := api.Store.CreateSession(context.Background(), "default", name)
			if err != nil {
				t.Fatal(err)
			}
			workspace, err := api.Store.LoadWorkspace(context.Background(), session.ID)
			if err != nil {
				t.Fatal(err)
			}
			workspace.Panes = []store.Pane{{ID: name + "-rdp", Kind: "rdp", Title: "RDP trust test", RDPTarget: upstream.address, Width: 900, Height: 650, X: 20, Y: 30, ZIndex: 1}}
			workspace.ActivePaneID = name + "-rdp"
			if err := api.Store.SaveWorkspace(context.Background(), workspace); err != nil {
				t.Fatal(err)
			}
			urls = append(urls, "/users/default/sessions/"+session.ID)
		}
		configs[engine] = map[string]string{"target": upstream.address, "url": urls[0], "otherURL": urls[1], "pane": engine + "-rdp", "otherPane": engine + "-other-rdp", "fingerprint": rdpCertificateFingerprint(upstream.certificate.Raw), "changedFingerprint": rdpCertificateFingerprint(replacement.certificate.Raw)}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/fixture/config", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, configs[r.URL.Query().Get("engine")])
	})
	mux.HandleFunc("/fixture/rotate", func(w http.ResponseWriter, r *http.Request) {
		upstream := upstreams[r.URL.Query().Get("engine")]
		if r.Method != http.MethodPost || upstream == nil {
			http.Error(w, "invalid fixture request", http.StatusBadRequest)
			return
		}
		upstream.mu.Lock()
		upstream.tlsCertificate = replacement.tlsCertificate
		upstream.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]bool{"rotated": true})
	})
	api.Register(mux)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r)
		if r.URL.Path == "/api/rdp-proxy/certificate" {
			for _, upstream := range upstreams {
				select {
				case <-upstream.requests:
				default:
				}
			}
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, "node", filepath.Join("..", "..", "scripts", "rdp-trust-browser-smoke.mjs"), "--playwright="+playwright, "--url="+server.URL)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("browser certificate trust check: %v\n%s", err, output)
	}
	t.Logf("%s", output)
}
