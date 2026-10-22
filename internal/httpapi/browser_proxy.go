package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
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
	htmlHeadPattern          = regexp.MustCompile(`(?i)<head(?:\s[^>]*)?>`)
	// htmlStartPattern spans whatever must stay ahead of an injected script in
	// a document without a <head> tag: a byte-order mark, comments, the doctype
	// and the <html> start tag. Anything before the doctype would put the page
	// in quirks mode.
	htmlStartPattern = regexp.MustCompile(`(?is)^\x{FEFF}?(?:\s|<!--.*?-->)*(?:<!doctype[^>]*>)?(?:\s|<!--.*?-->)*(?:<html(?:\s[^>]*)?>)?`)
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
			_, _ = fmt.Fprintf(w, "<!doctype html><title>Browser proxy error</title><p>Could not reach %s.</p><pre>%s</pre>", html.EscapeString(target.Host), html.EscapeString(err.Error()))
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
		// Relative redirects resolve against the requested URL, not the one the
		// session started at: http.FileServer answers /a/index.html with ./
		resolved, err := response.Request.URL.Parse(location)
		if err != nil || !sameURLOrigin(resolved, target) {
			return errors.New("browser proxy blocked a redirect outside its loopback origin")
		}
		rewritten := prefix + resolved.EscapedPath() + querySuffix(resolved.RawQuery)
		if resolved.Fragment != "" {
			rewritten += "#" + resolved.EscapedFragment()
		}
		response.Header.Set("Location", rewritten)
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
	// No <base> is injected: every proxied document's URL is already under
	// prefix + "/", so relative URLs resolve correctly against it, and a base
	// would break fragment links and override the page's own <base>.
	bootstrap := []byte(`<script>(function(){
const prefix=` + string(prefixJSON) + `, targetOrigin=` + string(targetJSON) + `;
const proxyURL=(value)=>{const u=new URL(String(value),location.href);if(u.origin===targetOrigin||u.origin===location.origin&&!u.pathname.startsWith(prefix+"/")){u.protocol=location.protocol;u.host=location.host;u.pathname=prefix+(u.pathname.startsWith("/")?u.pathname:"/"+u.pathname);}return u.href;};
const originalFetch=window.fetch;window.fetch=(input,init)=>originalFetch(input instanceof Request?new Request(proxyURL(input.url),input):proxyURL(input),init);
const originalOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){arguments[1]=proxyURL(url);return originalOpen.apply(this,arguments);};
const originalWindowOpen=window.open;window.open=function(url){if(url!==undefined&&url!==null&&String(url)!=="")arguments[0]=proxyURL(url);return originalWindowOpen.apply(window,arguments);};
for(const name of ["WebSocket","EventSource"]){const Original=window[name];if(!Original)continue;window[name]=function(url){arguments[0]=proxyURL(url);return Reflect.construct(Original,arguments,new.target||Original);};window[name].prototype=Original.prototype;}
const logicalURL=()=>targetOrigin+location.pathname.slice(prefix.length)+location.search+location.hash;
const report=()=>parent.postMessage({type:"tessera-browser-location",url:logicalURL()},"*");
addEventListener("message",event=>{if(event.source!==parent)return;if(event.data==="tessera-browser-back")history.back();else if(event.data==="tessera-browser-forward")history.forward();else if(event.data==="tessera-browser-reload")location.reload();});
addEventListener("popstate",report);addEventListener("hashchange",report);addEventListener("load",report);
const relayKeys=new Set(["[","]","BracketLeft","BracketRight","k","K","l","L",";","Semicolon","F7","F9","F10"]);
addEventListener("keydown",event=>{const primary=(event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey;const alt=event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey;const reorder=(event.ctrlKey||event.metaKey)&&event.shiftKey&&!event.altKey&&(event.key==="ArrowUp"||event.key==="ArrowDown");if(!primary&&!alt&&!reorder)return;if(!reorder&&!relayKeys.has(event.key)&&!relayKeys.has(event.code))return;event.preventDefault();parent.postMessage({type:"tessera-browser-key",key:event.key,code:event.code,ctrlKey:event.ctrlKey,metaKey:event.metaKey,altKey:event.altKey,shiftKey:event.shiftKey},"*");},true);
let drawPointer=null;
const relayDraw=(event,phase)=>parent.postMessage({type:"tessera-browser-draw",phase,pointerId:event.pointerId,clientX:event.clientX,clientY:event.clientY,shiftKey:event.shiftKey},"*");
const cancelDraw=()=>{if(drawPointer===null)return;const pointerId=drawPointer;drawPointer=null;relayDraw({pointerId,clientX:0,clientY:0},"cancel");if(document.documentElement.hasPointerCapture(pointerId))document.documentElement.releasePointerCapture(pointerId);};
addEventListener("pointerdown",event=>{if(event.button!==1)return;event.preventDefault();event.stopImmediatePropagation();if(drawPointer!==null)return;drawPointer=event.pointerId;document.documentElement.setPointerCapture(event.pointerId);relayDraw(event,"start");},true);
addEventListener("pointermove",event=>{if(event.pointerId!==drawPointer)return;event.preventDefault();event.stopImmediatePropagation();relayDraw(event,"move");},true);
addEventListener("pointerup",event=>{if(event.pointerId!==drawPointer)return;event.preventDefault();event.stopImmediatePropagation();drawPointer=null;relayDraw(event,"end");},true);
for(const type of ["pointercancel","lostpointercapture"])addEventListener(type,event=>{if(event.pointerId===drawPointer)cancelDraw();},true);
addEventListener("blur",cancelDraw);
addEventListener("keydown",event=>{if(event.key==="Escape"&&drawPointer!==null){event.preventDefault();event.stopImmediatePropagation();cancelDraw();}},true);
addEventListener("auxclick",event=>{if(event.button===1){event.preventDefault();event.stopImmediatePropagation();}},true);
document.addEventListener("click",event=>{const link=event.target.closest&&event.target.closest("a[href]");if(!link)return;const next=proxyURL(link.href);if(next===link.href)return;if(link.target&&link.target!=="_self"){link.href=next;return;}event.preventDefault();location.href=next;},true);
document.addEventListener("submit",event=>{const form=event.target;if(form&&form.action)form.action=proxyURL(form.action);},true);
})();</script>`)
	at := 0
	if head := htmlHeadPattern.FindIndex(body); head != nil {
		at = head[1]
	} else if start := htmlStartPattern.FindIndex(body); start != nil {
		at = start[1]
	}
	return append(append(append([]byte{}, body[:at]...), bootstrap...), body[at:]...)
}

// browserProxyEscapeScript reports the escaped path to the Tessera app, which
// sends the frame back through the pane's proxy session, and lets the page go
// back from its own link or the pane's Back button. Its hash is the only script
// the page's policy allows.
const browserProxyEscapeScript = `parent.postMessage({type:"tessera-browser-escape",path:location.pathname+location.search+location.hash},"*");document.getElementById("back").addEventListener("click",event=>{event.preventDefault();history.back();});addEventListener("message",event=>{if(event.source===parent&&event.data==="tessera-browser-back")history.back();});`

var browserProxyEscapePolicy = func() string {
	sum := sha256.Sum256([]byte(browserProxyEscapeScript))
	return "sandbox allow-scripts; default-src 'none'; script-src 'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
}()

// escapedBrowserNavigation reports whether r looks like a proxied page that
// navigated its frame to one of Tessera's own paths, for example with
// location.replace("/"). The bootstrap can't catch that: location can't be
// patched, and the Navigation API fires no events in an opaque-origin
// document. Tessera's own frames (terminal file transfers) are same-origin; a
// sandboxed proxied page has an opaque origin, so its navigations never are.
func escapedBrowserNavigation(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if dest := r.Header.Get("Sec-Fetch-Dest"); dest != "iframe" && dest != "frame" {
		return false
	}
	return r.Header.Get("Sec-Fetch-Site") != "same-origin" && !strings.HasPrefix(r.URL.Path, browserProxyPrefix)
}

// writeBrowserProxyEscape answers an escaped navigation with a small static
// page Tessera can frame, instead of the app behind X-Frame-Options: DENY,
// which Safari shows as a blank white frame.
func writeBrowserProxyEscape(w http.ResponseWriter, r *http.Request) {
	header := w.Header()
	header.Del("X-Frame-Options")
	header.Set("Content-Security-Policy", browserProxyEscapePolicy)
	header.Set("Content-Type", "text/html; charset=utf-8")
	header.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusForbidden)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>Left the browser proxy</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:2em;color:#333;background:#fff}@media(prefers-color-scheme:dark){body{color:#ddd;background:#1e1e1e}a{color:#8ab4f8}}code{word-break:break-all}</style>
<p>This page navigated outside the browser proxy, to Tessera's own <code>%s</code>, which Tessera does not show inside a Browser pane.</p>
<p>Tessera normally sends it back through the proxy straight away. If this page stays, the page used a root-relative navigation from script, such as <code>location.href = "/"</code>, that couldn't be redirected. <a id="back" href="#">Go back</a></p>
<script>%s</script>
`, html.EscapeString(r.URL.Path), browserProxyEscapeScript)
}

func setBrowserProxyResponseHeaders(header http.Header) {
	header.Set("Access-Control-Allow-Origin", "null")
	header.Set("Cross-Origin-Resource-Policy", "cross-origin")
	// The sandbox directive mirrors the pane iframe's sandbox attribute so proxied
	// pages keep an opaque origin even when opened outside the iframe (for
	// example "Open link in new tab"); otherwise they would share Tessera's
	// origin and could drive its API.
	header.Set("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src * ws: wss:; frame-src *; img-src * data: blob:; media-src * data: blob:")
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
