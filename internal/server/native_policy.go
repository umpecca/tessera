package server

import (
	"bufio"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"strings"
)

// DesktopCookie is provisioned directly into the native webview, never into a
// URL, command line, or JavaScript. The native host also blocks off-origin web
// requests because HTTP cookies are scoped by host, not by port.
const DesktopCookie = "tessera_desktop"

func validateDesktopOptions(opts Options) error {
	if opts.DesktopToken == "" {
		return nil
	}
	token, err := hex.DecodeString(opts.DesktopToken)
	if err != nil || len(token) != 32 {
		return errors.New("desktop token must contain 32 random bytes encoded as hex")
	}
	host, _, err := net.SplitHostPort(opts.Addr)
	if err != nil || host != "127.0.0.1" {
		return errors.New("desktop listener must bind to 127.0.0.1")
	}
	if opts.Updater != nil || opts.RequestRestart != nil || len(opts.TrustedProxies) != 0 || opts.WebDir != "" || len(opts.Users) != 0 {
		return errors.New("desktop mode does not support server updates, listener configuration, proxies, web overrides, or user rosters")
	}
	return nil
}

func desktopHandler(next http.Handler, address, token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		peer, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil || !net.ParseIP(peer).IsLoopback() || r.Host != address {
			http.Error(w, "desktop access denied", http.StatusForbidden)
			return
		}
		proxy := strings.HasPrefix(r.URL.Path, "/browser-proxy/")
		// Opaque-origin iframe fetches (including CORS preflights) cannot rely on
		// the app cookie. The proxy already authenticates its own 192-bit random
		// session ID and grants access only to that pre-authorized local target.
		// Creating or deleting a proxy still requires the application credential.
		proxyCapability := false
		if proxy {
			id, _, found := strings.Cut(strings.TrimPrefix(r.URL.Path, "/browser-proxy/"), "/")
			decoded, decodeErr := hex.DecodeString(id)
			proxyCapability = found && decodeErr == nil && len(decoded) == 24 &&
				strings.HasPrefix(r.URL.EscapedPath(), "/browser-proxy/"+id+"/")
		}
		cookie, err := r.Cookie(DesktopCookie)
		if !proxyCapability && (err != nil || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(token)) != 1) {
			http.Error(w, "desktop access denied", http.StatusForbidden)
			return
		}
		// Sandboxed Browser panes use an opaque origin. Only their existing proxy
		// transport may accept that origin; they cannot call the workspace API.
		origin := r.Header.Get("Origin")
		if origin != "" && origin != "http://"+address && !(proxy && origin == "null") {
			http.Error(w, "desktop origin denied", http.StatusForbidden)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/host/https") || strings.HasPrefix(r.URL.Path, "/local-https") || r.URL.Path == "/api/update" {
			http.Error(w, "server administration is unavailable in the desktop application", http.StatusForbidden)
			return
		}
		// Never forward the native credential through application proxies.
		r.Header.Del("Cookie")
		if proxy {
			// Browser content is untrusted even when served under our origin.
			// Restrict its network requests as well as its iframe capabilities;
			// localhost cookies must never travel to another local port.
			w = &desktopProxyResponse{ResponseWriter: w, origin: "http://" + address, socket: "ws://" + address}
		}
		next.ServeHTTP(w, r)
	})
}

type desktopProxyResponse struct {
	http.ResponseWriter
	origin, socket string
	wroteHeader    bool
}

func (w *desktopProxyResponse) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.wroteHeader = true
	w.Header().Set("Content-Security-Policy", "default-src "+w.origin+" data: blob:; script-src "+w.origin+" 'unsafe-inline' 'unsafe-eval'; style-src "+w.origin+" 'unsafe-inline'; connect-src "+w.origin+" "+w.socket+"; form-action "+w.origin+"; frame-src "+w.origin+"; object-src 'none'; sandbox allow-scripts allow-forms allow-downloads")
	w.ResponseWriter.WriteHeader(status)
}

func (w *desktopProxyResponse) Write(p []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(p)
}

func (w *desktopProxyResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *desktopProxyResponse) Flush() {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}
func (w *desktopProxyResponse) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(w.ResponseWriter).Hijack()
}
