package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	browserProxyPrefix      = "/browser-proxy/"
	browserProxySessionLife = 24 * time.Hour
	browserProxyRewriteMax  = 32 << 20
)

var (
	htmlRootAttributePattern = regexp.MustCompile(`(?i)(\b(?:src|href|action|poster)\s*=\s*["'])/([^/])`)
	cssRootURLPattern        = regexp.MustCompile(`(?i)(url\(\s*["']?)/([^/])`)
	jsRootImportPattern      = regexp.MustCompile(`(?m)((?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["']))/([^/])`)
)

type browserProxyManager struct {
	mu       sync.RWMutex
	sessions map[string]*browserProxySession
}

type browserProxySession struct {
	id        string
	target    *url.URL
	createdAt time.Time
	proxy     *httputil.ReverseProxy
}

type browserProxyCreateRequest struct {
	Target string `json:"target"`
}

func (a *API) proxyManager() *browserProxyManager {
	a.browserProxyOnce.Do(func() {
		a.browserProxy = &browserProxyManager{sessions: make(map[string]*browserProxySession)}
	})
	return a.browserProxy
}

func (a *API) browserProxyControl(w http.ResponseWriter, r *http.Request) {
	manager := a.proxyManager()
	if r.URL.Path == "/api/browser-proxy" {
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		var request browserProxyCreateRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid browser proxy request")
			return
		}
		target, err := normalizeBrowserProxyTarget(request.Target)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := validateLoopbackHost(r.Context(), target.Hostname()); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		session, err := newBrowserProxySession(target)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not create browser proxy")
			return
		}
		manager.add(session)
		path := browserProxyPrefix + session.id + target.EscapedPath()
		if target.RawQuery != "" {
			path += "?" + target.RawQuery
		}
		writeJSON(w, http.StatusCreated, map[string]string{
			"id":   session.id,
			"path": path,
			"url":  target.String(),
		})
		return
	}

	id := strings.TrimPrefix(r.URL.Path, "/api/browser-proxy/")
	if id == "" || strings.Contains(id, "/") {
		writeError(w, http.StatusNotFound, "unknown browser proxy")
		return
	}
	if r.Method != http.MethodDelete {
		methodNotAllowed(w, http.MethodDelete)
		return
	}
	manager.remove(id)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) browserProxyRequest(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, browserProxyPrefix)
	id, path, found := strings.Cut(rest, "/")
	if !found || id == "" {
		writeError(w, http.StatusNotFound, "unknown browser proxy")
		return
	}
	session := a.proxyManager().get(id)
	if session == nil {
		writeError(w, http.StatusNotFound, "browser proxy expired")
		return
	}

	clearProxySecurityHeaders(w.Header())
	if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
		setBrowserProxyResponseHeaders(w.Header())
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", r.Header.Get("Access-Control-Request-Headers"))
		w.Header().Set("Access-Control-Max-Age", "600")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	r.URL.Path = "/" + path
	r.URL.RawPath = ""
	session.proxy.ServeHTTP(w, r)
}

func normalizeBrowserProxyTarget(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("browser address is required")
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	target, err := url.Parse(raw)
	if err != nil || target.Hostname() == "" || target.User != nil {
		return nil, errors.New("invalid browser address")
	}
	target.Scheme = strings.ToLower(target.Scheme)
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, errors.New("browser address must use HTTP or HTTPS")
	}
	if target.Fragment != "" {
		target.Fragment = ""
	}
	if target.Path == "" {
		target.Path = "/"
	}
	if port := target.Port(); port != "" {
		if _, err := net.LookupPort("tcp", port); err != nil {
			return nil, errors.New("invalid browser address port")
		}
	}
	return target, nil
}

func validateLoopbackHost(ctx context.Context, host string) error {
	if addr, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
		if !addr.Unmap().IsLoopback() {
			return errors.New("browser proxy targets must be loopback addresses")
		}
		return nil
	}
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(addresses) == 0 {
		return errors.New("browser proxy target could not be resolved")
	}
	for _, address := range addresses {
		if !address.Unmap().IsLoopback() {
			return errors.New("browser proxy targets must resolve only to loopback")
		}
	}
	return nil
}

func newBrowserProxySession(requested *url.URL) (*browserProxySession, error) {
	var token [24]byte
	if _, err := rand.Read(token[:]); err != nil {
		return nil, err
	}
	target := &url.URL{Scheme: requested.Scheme, Host: requested.Host}
	session := &browserProxySession{
		id:        hex.EncodeToString(token[:]),
		target:    target,
		createdAt: time.Now(),
	}
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           dialLoopback,
		ForceAttemptHTTP2:     true,
		ResponseHeaderTimeout: 30 * time.Second,
		TLSClientConfig: &tls.Config{
			// The destination is pinned to loopback by DialContext. Local HTTPS
			// development servers commonly use self-signed certificates.
			InsecureSkipVerify: true, //nolint:gosec
		},
	}
	prefix := browserProxyPrefix + session.id
	session.proxy = &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(target)
			request.Out.Host = target.Host
			request.Out.Header.Del("Cookie")
			request.Out.Header.Del("Accept-Encoding")
			request.Out.Header.Set("Origin", target.Scheme+"://"+target.Host)
			if request.Out.Header.Get("Referer") != "" {
				request.Out.Header.Set("Referer", target.Scheme+"://"+target.Host+request.Out.URL.Path)
			}
		},
		ModifyResponse: func(response *http.Response) error {
			return rewriteBrowserProxyResponse(response, prefix, target)
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			clearProxySecurityHeaders(w.Header())
			setBrowserProxyResponseHeaders(w.Header())
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = fmt.Fprintf(w, "<!doctype html><title>Browser proxy error</title><p>Could not reach %s.</p><pre>%s</pre>", target.Host, err)
		},
	}
	return session, nil
}

func dialLoopback(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errors.New("invalid browser proxy destination")
	}
	if err := validateLoopbackHost(ctx, host); err != nil {
		return nil, err
	}
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(addresses) == 0 {
		return nil, errors.New("browser proxy destination could not be resolved")
	}
	var lastErr error
	dialer := net.Dialer{Timeout: 10 * time.Second}
	for _, address := range addresses {
		if !address.Unmap().IsLoopback() {
			return nil, errors.New("browser proxy destination changed to a non-loopback address")
		}
		connection, err := dialer.DialContext(ctx, network, net.JoinHostPort(address.String(), port))
		if err == nil {
			return connection, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func rewriteBrowserProxyResponse(response *http.Response, prefix string, target *url.URL) error {
	clearProxySecurityHeaders(response.Header)
	setBrowserProxyResponseHeaders(response.Header)
	response.Header.Del("Set-Cookie")
	if location := response.Header.Get("Location"); location != "" {
		resolved, err := target.Parse(location)
		if err != nil || !sameURLOrigin(resolved, target) {
			return errors.New("browser proxy blocked a redirect outside its loopback origin")
		}
		response.Header.Set("Location", prefix+resolved.EscapedPath()+querySuffix(resolved.RawQuery))
	}

	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))
	if mediaType != "text/html" && mediaType != "text/css" && mediaType != "application/javascript" && mediaType != "text/javascript" {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, browserProxyRewriteMax+1))
	_ = response.Body.Close()
	if err != nil {
		return err
	}
	if len(body) > browserProxyRewriteMax {
		return errors.New("browser proxy response is too large to rewrite")
	}

	switch mediaType {
	case "text/html":
		body = rewriteBrowserHTML(body, prefix, target)
	case "text/css":
		body = cssRootURLPattern.ReplaceAll(body, []byte("$1"+prefix+"/$2"))
	case "application/javascript", "text/javascript":
		body = jsRootImportPattern.ReplaceAll(body, []byte("$1"+prefix+"/$3"))
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	response.ContentLength = int64(len(body))
	response.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))
	response.Header.Del("Content-Encoding")
	response.Header.Del("ETag")
	return nil
}

func rewriteBrowserHTML(body []byte, prefix string, target *url.URL) []byte {
	body = htmlRootAttributePattern.ReplaceAll(body, []byte("$1"+prefix+"/$2"))
	body = cssRootURLPattern.ReplaceAll(body, []byte("$1"+prefix+"/$2"))
	prefixJSON, _ := json.Marshal(prefix)
	targetJSON, _ := json.Marshal(target.Scheme + "://" + target.Host)
	bootstrap := []byte(`<base href="` + prefix + `/"><script>(function(){
const prefix=` + string(prefixJSON) + `, targetOrigin=` + string(targetJSON) + `;
const proxyURL=(value)=>{const u=new URL(String(value),location.href);if(u.origin===targetOrigin||u.origin===location.origin&&!u.pathname.startsWith(prefix+"/")){u.protocol=location.protocol;u.host=location.host;u.pathname=prefix+(u.pathname.startsWith("/")?u.pathname:"/"+u.pathname);}return u.href;};
const originalFetch=window.fetch;window.fetch=(input,init)=>originalFetch(input instanceof Request?new Request(proxyURL(input.url),input):proxyURL(input),init);
const originalOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){arguments[1]=proxyURL(url);return originalOpen.apply(this,arguments);};
for(const name of ["WebSocket","EventSource"]){const Original=window[name];if(!Original)continue;window[name]=function(url){arguments[0]=proxyURL(url);return Reflect.construct(Original,arguments,new.target||Original);};window[name].prototype=Original.prototype;}
const logicalURL=()=>targetOrigin+location.pathname.slice(prefix.length)+location.search+location.hash;
const report=()=>parent.postMessage({type:"tessera-browser-location",url:logicalURL()},"*");
addEventListener("message",event=>{if(event.source!==parent)return;if(event.data==="tessera-browser-back")history.back();else if(event.data==="tessera-browser-forward")history.forward();else if(event.data==="tessera-browser-reload")location.reload();});
addEventListener("popstate",report);addEventListener("hashchange",report);addEventListener("load",report);
document.addEventListener("click",event=>{const link=event.target.closest&&event.target.closest("a[href]");if(!link||link.target&&link.target!=="_self")return;const next=proxyURL(link.href);if(next!==link.href){event.preventDefault();location.href=next;}},true);
document.addEventListener("submit",event=>{const form=event.target;if(form&&form.action)form.action=proxyURL(form.action);},true);
})();</script>`)
	lower := bytes.ToLower(body)
	if index := bytes.Index(lower, []byte("<head>")); index >= 0 {
		at := index + len("<head>")
		return append(append(append([]byte{}, body[:at]...), bootstrap...), body[at:]...)
	}
	return append(bootstrap, body...)
}

func setBrowserProxyResponseHeaders(header http.Header) {
	header.Set("Access-Control-Allow-Origin", "null")
	header.Set("Cross-Origin-Resource-Policy", "cross-origin")
	header.Set("Content-Security-Policy", "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src * ws: wss:; frame-src *; img-src * data: blob:; media-src * data: blob:")
	header.Set("Referrer-Policy", "no-referrer")
}

func clearProxySecurityHeaders(header http.Header) {
	header.Del("X-Frame-Options")
	header.Del("Content-Security-Policy")
	header.Del("Content-Security-Policy-Report-Only")
	header.Del("Permissions-Policy")
	header.Del("Cross-Origin-Opener-Policy")
	header.Del("Cross-Origin-Embedder-Policy")
	header.Del("Cross-Origin-Resource-Policy")
	header.Del("Referrer-Policy")
}

func sameURLOrigin(left, right *url.URL) bool {
	return strings.EqualFold(left.Scheme, right.Scheme) && strings.EqualFold(left.Host, right.Host)
}

func querySuffix(query string) string {
	if query == "" {
		return ""
	}
	return "?" + query
}

func (m *browserProxyManager) add(session *browserProxySession) {
	now := time.Now()
	m.mu.Lock()
	for id, candidate := range m.sessions {
		if now.Sub(candidate.createdAt) > browserProxySessionLife {
			delete(m.sessions, id)
			candidate.proxy.Transport.(*http.Transport).CloseIdleConnections()
		}
	}
	m.sessions[session.id] = session
	m.mu.Unlock()
}

func (m *browserProxyManager) get(id string) *browserProxySession {
	m.mu.RLock()
	session := m.sessions[id]
	m.mu.RUnlock()
	if session != nil && time.Since(session.createdAt) <= browserProxySessionLife {
		return session
	}
	if session != nil {
		m.remove(id)
	}
	return nil
}

func (m *browserProxyManager) remove(id string) {
	m.mu.Lock()
	session := m.sessions[id]
	delete(m.sessions, id)
	m.mu.Unlock()
	if transport, ok := sessionTransport(session); ok {
		transport.CloseIdleConnections()
	}
}

func sessionTransport(session *browserProxySession) (*http.Transport, bool) {
	if session == nil || session.proxy == nil {
		return nil, false
	}
	transport, ok := session.proxy.Transport.(*http.Transport)
	return transport, ok
}
