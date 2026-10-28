package httpapi

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"tessera/internal/auth"
	"tessera/internal/rdpsession"
	"tessera/internal/store"
)

type keptHarness struct {
	t       *testing.T
	server  *httptest.Server
	manager *rdpsession.Manager
	target  string
	cookies map[string]string
	spaces  map[string]string // account -> workspace id
}

// keptHarnessIdleLimit is long enough that no test session ends idle.
const keptHarnessIdleLimit = 3 * time.Hour

// newKeptHarness serves the API behind file sign-in with accounts alice and
// bob, each with a workspace, and a fake RDP server address.
func newKeptHarness(t *testing.T) *keptHarness {
	t.Helper()
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	path := filepath.Join(t.TempDir(), "credentials")
	writeAccounts(t, path, map[string]string{"alice": "alice-password", "bob": "bob-password"})

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			t.Cleanup(func() { conn.Close() })
		}
	}()

	h := &keptHarness{t: t, manager: rdpsession.NewFakeManager(keptHarnessIdleLimit), target: listener.Addr().String(), cookies: map[string]string{}, spaces: map[string]string{}}
	t.Cleanup(func() { h.manager.Shutdown(context.Background()) })
	api := &API{Store: st, AuthMode: AuthFile, RDPSessions: h.manager}
	mux := http.NewServeMux()
	api.Register(mux)
	gate := NewAuthHandler(mux, st, AuthOptions{Mode: AuthFile, Credentials: auth.NewCredentials(path)})
	h.server = httptest.NewServer(NewSecurityHandler(gate, st, SecurityOptions{ConnectionLog: io.Discard}))
	t.Cleanup(h.server.Close)

	for _, name := range []string{"alice", "bob"} {
		client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		response, err := client.PostForm(h.server.URL+"/login", url.Values{"username": {name}, "password": {name + "-password"}})
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		for _, c := range response.Cookies() {
			if c.Name == signInCookie {
				h.cookies[name] = c.Value
			}
		}
		if h.cookies[name] == "" {
			t.Fatalf("%s did not sign in", name)
		}
		session, err := st.CreateSession(context.Background(), name, "desk")
		if err != nil {
			t.Fatal(err)
		}
		h.spaces[name] = session.ID
	}
	return h
}

func (h *keptHarness) post(account, path string, body any) (int, []byte) {
	h.t.Helper()
	raw, _ := json.Marshal(body)
	request, _ := http.NewRequest(http.MethodPost, h.server.URL+path, bytes.NewReader(raw))
	request.Header.Set("Cookie", signInCookie+"="+h.cookies[account])
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	return response.StatusCode, data
}

type rdpKeptListing struct {
	Sessions         []rdpKeptInfo `json:"sessions"`
	IdleLimitSeconds int64         `json:"idleLimitSeconds"`
}

func (h *keptHarness) list(account string) []rdpKeptInfo {
	h.t.Helper()
	return h.listing(account).Sessions
}

func (h *keptHarness) listing(account string) rdpKeptListing {
	h.t.Helper()
	request, _ := http.NewRequest(http.MethodGet, h.server.URL+"/api/rdp-kept", nil)
	request.Header.Set("Cookie", signInCookie+"="+h.cookies[account])
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	var result rdpKeptListing
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		h.t.Fatal(err)
	}
	return result
}

func (h *keptHarness) createBody(account, pane string) map[string]any {
	return map[string]any{
		"workspaceId": h.spaces[account], "pane": pane, "target": h.target,
		"fingerprint": strings.Repeat("ab", 32), "username": "jane", "password": "secret",
		"width": 1216, "height": 640, "h264": true,
	}
}

func (h *keptHarness) view(account, workspaceID, pane string) (*websocket.Conn, *http.Response, error) {
	header := http.Header{"Cookie": {signInCookie + "=" + h.cookies[account]}, "Origin": {h.server.URL}}
	address := "ws" + strings.TrimPrefix(h.server.URL, "http") + "/api/rdp-kept/view?workspaceId=" + url.QueryEscape(workspaceID) + "&pane=" + url.QueryEscape(pane)
	return websocket.DefaultDialer.Dial(address, header)
}

func readFrame(t *testing.T, conn *websocket.Conn) []byte {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	messageType, message, err := conn.ReadMessage()
	if err != nil || messageType != websocket.BinaryMessage {
		t.Fatalf("reading a frame: type %d, %v", messageType, err)
	}
	return message
}

// web/rdp-kept.test.mjs asserts the same list for the browser's request, so
// renaming a field on either side fails a test.
func TestKeptRequestFieldsMatchTheBrowser(t *testing.T) {
	want := []string{"domain", "fingerprint", "h264", "height", "pane", "password", "pixelRatio", "scaleFactor", "scaledHeight", "scaledWidth", "target", "username", "width", "workspaceId"}
	var got []string
	requestType := reflect.TypeOf(rdpKeptRequest{})
	for i := 0; i < requestType.NumField(); i++ {
		got = append(got, strings.Split(requestType.Field(i).Tag.Get("json"), ",")[0])
	}
	sort.Strings(got)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("request fields = %v, want %v", got, want)
	}
}

func TestKeptSessionLifecycle(t *testing.T) {
	h := newKeptHarness(t)
	status, body := h.post("alice", "/api/rdp-kept", h.createBody("alice", "pane-1"))
	if status != http.StatusCreated {
		t.Fatalf("create = %d %s", status, body)
	}
	var created rdpKeptInfo
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatal(err)
	}
	if created.State != "active" || created.Width != 1216 || created.Height != 640 || created.Pane != "pane-1" || created.Target != h.target {
		t.Fatalf("created = %+v", created)
	}
	if strings.Contains(string(body), "secret") {
		t.Fatal("the response includes the password")
	}
	if sessions := h.list("alice"); len(sessions) != 1 || sessions[0].Pane != "pane-1" || sessions[0].State != "active" {
		t.Fatalf("alice's sessions = %+v", sessions)
	}
	if sessions := h.list("bob"); len(sessions) != 0 {
		t.Fatalf("bob sees alice's sessions: %+v", sessions)
	}
	if status, _ := h.post("alice", "/api/rdp-kept", h.createBody("alice", "pane-1")); status != http.StatusConflict {
		t.Fatalf("a second create = %d, want 409", status)
	}
	disconnect := map[string]any{"workspaceId": h.spaces["alice"], "pane": "pane-1"}
	if status, _ := h.post("bob", "/api/rdp-kept/disconnect", disconnect); status != http.StatusNotFound {
		t.Fatalf("bob disconnecting alice's session = %d, want 404", status)
	}
	if status, _ := h.post("alice", "/api/rdp-kept/rejoin", disconnect); status != http.StatusConflict {
		t.Fatalf("rejoining an active session = %d, want 409", status)
	}
	if status, _ := h.post("alice", "/api/rdp-kept/disconnect", disconnect); status != http.StatusNoContent {
		t.Fatalf("disconnect = %d, want 204", status)
	}
	if sessions := h.list("alice"); len(sessions) != 0 {
		t.Fatalf("a disconnected session is still listed: %+v", sessions)
	}
	if status, _ := h.post("alice", "/api/rdp-kept/disconnect", disconnect); status != http.StatusNotFound {
		t.Fatalf("disconnecting twice = %d, want 404", status)
	}
}

func TestKeptSessionRejectsBadRequests(t *testing.T) {
	h := newKeptHarness(t)
	mutate := func(change func(map[string]any)) int {
		body := h.createBody("alice", "pane-1")
		change(body)
		status, _ := h.post("alice", "/api/rdp-kept", body)
		return status
	}
	for name, change := range map[string]func(map[string]any){
		"a pane with a slash":        func(b map[string]any) { b["pane"] = "../pane" },
		"an empty pane":              func(b map[string]any) { b["pane"] = "" },
		"no fingerprint":             func(b map[string]any) { b["fingerprint"] = "" },
		"a short fingerprint":        func(b map[string]any) { b["fingerprint"] = "abcd" },
		"no user name":               func(b map[string]any) { b["username"] = "" },
		"a tiny desktop":             func(b map[string]any) { b["width"] = 50 },
		"a huge desktop":             func(b map[string]any) { b["height"] = 100000 },
		"a bad target":               func(b map[string]any) { b["target"] = "rdp://user:pw@host" },
		"an unknown field":           func(b map[string]any) { b["admin"] = true },
		"someone else's workspace":   func(b map[string]any) { b["workspaceId"] = h.spaces["bob"] },
		"a workspace that isn't one": func(b map[string]any) { b["workspaceId"] = "nope" },
	} {
		if status := mutate(change); status < 400 || status >= 500 {
			t.Errorf("%s: status %d, want a 4xx", name, status)
		}
	}
	if sessions := h.list("alice"); len(sessions) != 0 {
		t.Fatalf("a rejected request left a session: %+v", sessions)
	}
}

func TestKeptSessionViewerCarriesTheProtocol(t *testing.T) {
	h := newKeptHarness(t)
	if status, body := h.post("alice", "/api/rdp-kept", h.createBody("alice", "pane-1")); status != http.StatusCreated {
		t.Fatalf("create = %d %s", status, body)
	}
	conn, _, err := h.view("alice", h.spaces["alice"], "pane-1")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if frame := readFrame(t, conn); !bytes.Equal(frame, []byte{rdpsession.ViewDesktopSize, 0xc0, 0x04, 0x80, 0x02}) {
		t.Fatalf("first frame = %v, want the 1216x640 desktop size", frame)
	}
	// Input goes to the module, which echoes it back as an H.264 event.
	input := []byte{4, 0x1e, 0x00, 1} // key 0x1e pressed
	if err := conn.WriteMessage(websocket.BinaryMessage, append([]byte{rdpsession.ViewInput}, input...)); err != nil {
		t.Fatal(err)
	}
	if frame := readFrame(t, conn); !bytes.Equal(frame, append([]byte{rdpsession.ViewH264}, input...)) {
		t.Fatalf("echoed frame = %v", frame)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte{rdpsession.ViewRefresh}); err != nil {
		t.Fatal(err)
	}
	if frame := readFrame(t, conn); !bytes.Equal(frame, []byte{rdpsession.ViewImage, 9}) {
		t.Fatalf("refresh answer = %v", frame)
	}
	// A message the protocol doesn't allow closes the connection.
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte{99}); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, _, err := conn.ReadMessage(); !websocket.IsCloseError(err, websocket.CloseProtocolError) {
		t.Fatalf("after an invalid message: %v, want a protocol error close", err)
	}
	// The session survives its viewer: a new one attaches to the same session.
	again, _, err := h.view("alice", h.spaces["alice"], "pane-1")
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if frame := readFrame(t, again); frame[0] != rdpsession.ViewDesktopSize {
		t.Fatalf("first frame of the second viewer = %v", frame)
	}
}

func TestKeptSessionViewerIsOwnerOnly(t *testing.T) {
	h := newKeptHarness(t)
	if status, body := h.post("alice", "/api/rdp-kept", h.createBody("alice", "pane-1")); status != http.StatusCreated {
		t.Fatalf("create = %d %s", status, body)
	}
	for name, attempt := range map[string]func() (*http.Response, error){
		"bob in alice's workspace": func() (*http.Response, error) {
			_, response, err := h.view("bob", h.spaces["alice"], "pane-1")
			return response, err
		},
		"bob in his own workspace": func() (*http.Response, error) {
			_, response, err := h.view("bob", h.spaces["bob"], "pane-1")
			return response, err
		},
		"alice, wrong pane": func() (*http.Response, error) {
			_, response, err := h.view("alice", h.spaces["alice"], "pane-2")
			return response, err
		},
	} {
		response, err := attempt()
		if err == nil || response == nil || response.StatusCode < 400 || response.StatusCode >= 500 {
			t.Errorf("%s: err %v, response %v, want a 4xx refusal", name, err, response)
		}
	}
	// A foreign origin is refused even for the owner.
	header := http.Header{"Cookie": {signInCookie + "=" + h.cookies["alice"]}, "Origin": {"https://evil.example"}}
	address := "ws" + strings.TrimPrefix(h.server.URL, "http") + "/api/rdp-kept/view?workspaceId=" + h.spaces["alice"] + "&pane=pane-1"
	if _, response, err := websocket.DefaultDialer.Dial(address, header); err == nil || response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign origin: err %v, response %v, want 403", err, response)
	}
}

func TestKeptSessionNeedsSignInAndHTTPS(t *testing.T) {
	signed := func(r *http.Request, account string) *http.Request {
		return r.WithContext(context.WithValue(r.Context(), signInKey{}, store.SignIn{Account: account}))
	}
	remote := func() *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/api/rdp-kept", nil)
		r.RemoteAddr = "203.0.113.5:4000"
		return r
	}
	local := func() *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/api/rdp-kept", nil)
		r.RemoteAddr = "127.0.0.1:4000"
		return r
	}
	secure := func() *http.Request {
		r := remote()
		r.TLS = &tls.ConnectionState{}
		return r
	}
	manager := rdpsession.NewFakeManager(0)
	t.Cleanup(func() { manager.Shutdown(context.Background()) })
	for _, tc := range []struct {
		name string
		api  *API
		req  *http.Request
		want int
	}{
		{"a server without the feature", &API{AuthMode: AuthFile}, signed(local(), "alice"), http.StatusNotFound},
		{"sign-in off", &API{AuthMode: AuthOff, RDPSessions: manager}, local(), http.StatusForbidden},
		{"no signed-in account", &API{AuthMode: AuthFile, RDPSessions: manager}, local(), http.StatusForbidden},
		{"a remote client over plain HTTP", &API{AuthMode: AuthFile, RDPSessions: manager}, signed(remote(), "alice"), http.StatusForbidden},
		{"a remote client over HTTPS", &API{AuthMode: AuthFile, RDPSessions: manager}, signed(secure(), "alice"), http.StatusOK},
		{"loopback over HTTP", &API{AuthMode: AuthFile, RDPSessions: manager}, signed(local(), "alice"), http.StatusOK},
	} {
		recorder := httptest.NewRecorder()
		tc.api.rdpKept(recorder, tc.req)
		if recorder.Code != tc.want {
			t.Errorf("%s: status %d, want %d (%s)", tc.name, recorder.Code, tc.want, recorder.Body.String())
		}
	}
}

// The browser shows the idle limit beside the keep checkbox.
func TestRDPKeptListReportsIdleLimit(t *testing.T) {
	h := newKeptHarness(t)
	if got := h.listing("alice").IdleLimitSeconds; got != int64(keptHarnessIdleLimit/time.Second) {
		t.Fatalf("idleLimitSeconds = %d, want %d", got, int64(keptHarnessIdleLimit/time.Second))
	}
}

func TestKeptSessionKeepsItsPixelRatio(t *testing.T) {
	h := newKeptHarness(t)
	refused := h.createBody("alice", "pane-1")
	refused["pixelRatio"] = 3
	if status, body := h.post("alice", "/api/rdp-kept", refused); status != http.StatusBadRequest {
		t.Fatalf("create with pixel ratio 3 = %d %s", status, body)
	}
	scaled := h.createBody("alice", "pane-1")
	scaled["pixelRatio"] = 2
	status, body := h.post("alice", "/api/rdp-kept", scaled)
	if status != http.StatusCreated {
		t.Fatalf("create = %d %s", status, body)
	}
	var created rdpKeptInfo
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatal(err)
	}
	if created.PixelRatio != 2 {
		t.Fatalf("created pixel ratio = %v", created.PixelRatio)
	}
	if sessions := h.list("alice"); len(sessions) != 1 || sessions[0].PixelRatio != 2 {
		t.Fatalf("listed = %+v", sessions)
	}
}

func TestKeptSessionKeepsItsScaledLayout(t *testing.T) {
	h := newKeptHarness(t)
	for _, bad := range []map[string]any{
		{"scaledWidth": 1920, "scaledHeight": 1200, "scaleFactor": 50},
		{"scaledWidth": 1921, "scaledHeight": 1200, "scaleFactor": 200},
		{"scaledWidth": 0, "scaledHeight": 1200, "scaleFactor": 200},
	} {
		body := h.createBody("alice", "pane-1")
		for key, value := range bad {
			body[key] = value
		}
		if status, response := h.post("alice", "/api/rdp-kept", body); status != http.StatusBadRequest {
			t.Fatalf("create with %v = %d %s", bad, status, response)
		}
	}
	body := h.createBody("alice", "pane-1")
	body["scaledWidth"], body["scaledHeight"], body["scaleFactor"], body["pixelRatio"] = 1920, 1048, 200, 1.4
	status, response := h.post("alice", "/api/rdp-kept", body)
	if status != http.StatusCreated {
		t.Fatalf("create = %d %s", status, response)
	}
	var created rdpKeptInfo
	if err := json.Unmarshal(response, &created); err != nil {
		t.Fatal(err)
	}
	if created.ScaledWidth != 1920 || created.ScaledHeight != 1048 || created.ScaleFactor != 200 || created.PixelRatio != 1.4 {
		t.Fatalf("created = %+v", created)
	}
}
