package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"tessera/internal/store"
)

func TestLiveSocketsCloseWhenSignInEnds(t *testing.T) {
	signInWatchInterval = 50 * time.Millisecond
	defer func() { signInWatchInterval = 30 * time.Second }()

	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	writeAccounts(t, st, map[string]string{"alice": "alice-password", "bob": "bob-password"})
	mux := http.NewServeMux()
	upgrader := websocket.Upgrader{}
	mux.HandleFunc("/api/socket", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		defer closeOnSignInEnd(r.Context(), conn)()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	gate := NewAuthHandler(mux, st, AuthOptions{Mode: AuthFile})
	server := httptest.NewServer(NewSecurityHandler(gate, st, SecurityOptions{ConnectionLog: io.Discard}))
	defer server.Close()

	signIn := func(name, password string) string {
		client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		response, err := client.PostForm(server.URL+"/login", url.Values{"username": {name}, "password": {password}})
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		for _, c := range response.Cookies() {
			if c.Name == signInCookie {
				return c.Value
			}
		}
		t.Fatalf("%s did not sign in", name)
		return ""
	}
	open := func(cookie string) *websocket.Conn {
		header := http.Header{"Cookie": {signInCookie + "=" + cookie}}
		conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/api/socket", header)
		if err != nil {
			t.Fatal(err)
		}
		return conn
	}
	closeCode := func(conn *websocket.Conn) int {
		_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, _, err := conn.ReadMessage()
		if closeErr, ok := err.(*websocket.CloseError); ok {
			return closeErr.Code
		}
		return -1
	}

	alice, bob := signIn("alice", "alice-password"), signIn("bob", "bob-password")
	aliceSocket, bobSocket := open(alice), open(bob)
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/logout", nil)
	request.Header.Set("Cookie", signInCookie+"="+alice)
	if response, err := http.DefaultClient.Do(request); err != nil || response.StatusCode != http.StatusNoContent {
		t.Fatalf("logout: %v", err)
	}
	if code := closeCode(aliceSocket); code != signInEndedCloseCode {
		t.Fatalf("signed-out socket closed with %d", code)
	}
	// Bob's socket is untouched until his password changes on disk.
	editAccounts(t, st, "bob", "new-password")
	if code := closeCode(bobSocket); code != signInEndedCloseCode {
		t.Fatalf("password-changed socket closed with %d", code)
	}
}
