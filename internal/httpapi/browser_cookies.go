package httpapi

import (
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"tessera/internal/store"
)

const (
	browserCookieMaxSize = 4096
	browserCookieMax     = 180
)

// browserCookieJar holds a development server's cookies for Browser panes
// (task 242). The proxy sends them with each request and keeps Set-Cookie
// from the browser; the page's document.cookie stand-in reads and writes the
// ones that aren't HttpOnly. A jar holds one host's host-only cookies, so
// domains never need matching. SameSite is kept but not enforced: every
// request comes from the development server's own pages.
type browserCookieJar struct {
	host string

	mu      sync.Mutex
	cookies []*browserJarCookie
	// version counts changes to the persistent cookies, so a slow save never
	// overwrites a newer one.
	version int

	saveMu  sync.Mutex
	saved   int
	persist func([]store.BrowserCookie)
}

type browserJarCookie struct {
	store.BrowserCookie
	// session cookies (no Expires or Max-Age) last until Tessera stops.
	session bool
}

func newBrowserCookieJar(host string, stored []store.BrowserCookie, persist func([]store.BrowserCookie)) *browserCookieJar {
	jar := &browserCookieJar{host: strings.ToLower(host), persist: persist}
	for _, cookie := range stored {
		jar.cookies = append(jar.cookies, &browserJarCookie{BrowserCookie: cookie})
	}
	return jar
}

// setFromResponse stores a Set-Cookie line from a response to a request for
// requestPath. It reports whether a cookie script can see changed.
func (j *browserCookieJar) setFromResponse(requestPath, line string, now time.Time) bool {
	cookie, err := http.ParseSetCookie(line)
	if err != nil {
		return false
	}
	return j.set(cookie, requestPath, false, now)
}

// setFromScript stores a document.cookie assignment made on a page at
// documentPath, which can neither set nor replace an HttpOnly cookie.
func (j *browserCookieJar) setFromScript(documentPath, raw string, now time.Time) bool {
	cookie, err := http.ParseSetCookie(raw)
	if err != nil || cookie.HttpOnly {
		return false
	}
	return j.set(cookie, documentPath, true, now)
}

func (j *browserCookieJar) set(cookie *http.Cookie, fromPath string, fromScript bool, now time.Time) bool {
	if domain := strings.TrimPrefix(strings.ToLower(cookie.Domain), "."); domain != "" && domain != j.host {
		return false
	}
	if len(cookie.Name)+len(cookie.Value) > browserCookieMaxSize {
		return false
	}
	path := cookie.Path
	if !strings.HasPrefix(path, "/") {
		path = browserCookieDefaultPath(fromPath)
	}
	next := &browserJarCookie{BrowserCookie: store.BrowserCookie{
		Name: cookie.Name, Value: cookie.Value, Path: path, Secure: cookie.Secure, HTTPOnly: cookie.HttpOnly,
		SameSite: browserCookieSameSite(cookie.SameSite), Created: now.UnixNano(),
	}}
	remove := false
	switch {
	case cookie.MaxAge < 0:
		remove = true
	case cookie.MaxAge > 0:
		next.Expires = now.Unix() + int64(cookie.MaxAge)
	case !cookie.Expires.IsZero():
		next.Expires = cookie.Expires.Unix()
		remove = !cookie.Expires.After(now)
	default:
		next.session = true
	}

	j.mu.Lock()
	index := -1
	for i, existing := range j.cookies {
		if existing.Name == next.Name && existing.Path == next.Path {
			index = i
			break
		}
	}
	var previous *browserJarCookie
	if index >= 0 {
		previous = j.cookies[index]
		if fromScript && previous.HTTPOnly {
			j.mu.Unlock()
			return false
		}
		next.Created = previous.Created
		j.cookies = append(j.cookies[:index], j.cookies[index+1:]...)
	}
	if remove && previous == nil {
		j.mu.Unlock()
		return false
	}
	if !remove {
		j.cookies = append(j.cookies, next)
		j.evictLocked(now)
	}
	persistent := (previous != nil && !previous.session) || (!remove && !next.session)
	visible := (previous != nil && !previous.HTTPOnly) || (!remove && !next.HTTPOnly)
	j.mu.Unlock()
	if persistent {
		j.save()
	}
	return visible
}

// evictLocked keeps the jar within browserCookieMax: expired cookies go
// first, then the oldest.
func (j *browserCookieJar) evictLocked(now time.Time) {
	if len(j.cookies) <= browserCookieMax {
		return
	}
	kept := j.cookies[:0]
	for _, cookie := range j.cookies {
		if !cookie.expired(now) {
			kept = append(kept, cookie)
		}
	}
	j.cookies = kept
	if extra := len(j.cookies) - browserCookieMax; extra > 0 {
		sort.SliceStable(j.cookies, func(a, b int) bool { return j.cookies[a].Created < j.cookies[b].Created })
		j.cookies = j.cookies[extra:]
	}
}

func (c *browserJarCookie) expired(now time.Time) bool {
	return !c.session && c.Expires <= now.Unix()
}

// requestHeader is the Cookie header for a request to path.
func (j *browserCookieJar) requestHeader(path string, now time.Time) string {
	return j.header(path, now, true)
}

// scriptCookies is what document.cookie reads on a page at path.
func (j *browserCookieJar) scriptCookies(path string, now time.Time) string {
	return j.header(path, now, false)
}

func (j *browserCookieJar) header(path string, now time.Time, httpOnly bool) string {
	if path == "" {
		path = "/"
	}
	j.mu.Lock()
	var matched []*browserJarCookie
	for _, cookie := range j.cookies {
		if !cookie.expired(now) && (httpOnly || !cookie.HTTPOnly) && browserCookiePathMatch(path, cookie.Path) {
			matched = append(matched, cookie)
		}
	}
	j.mu.Unlock()
	// Longer paths first, then the oldest, as RFC 6265 asks.
	sort.SliceStable(matched, func(a, b int) bool {
		if len(matched[a].Path) != len(matched[b].Path) {
			return len(matched[a].Path) > len(matched[b].Path)
		}
		return matched[a].Created < matched[b].Created
	})
	pairs := make([]string, len(matched))
	for i, cookie := range matched {
		pairs[i] = cookie.Name + "=" + cookie.Value
	}
	return strings.Join(pairs, "; ")
}

// clear empties the jar and retires any save still to come, so the caller
// can clear the stored cookies after it returns.
func (j *browserCookieJar) clear() {
	j.mu.Lock()
	j.cookies = nil
	j.version++
	version := j.version
	j.mu.Unlock()
	j.saveMu.Lock()
	j.saved = version
	j.saveMu.Unlock()
}

// save hands the persistent cookies to persist, unless a newer save already
// has.
func (j *browserCookieJar) save() {
	if j.persist == nil {
		return
	}
	j.mu.Lock()
	j.version++
	version := j.version
	var cookies []store.BrowserCookie
	for _, cookie := range j.cookies {
		if !cookie.session {
			cookies = append(cookies, cookie.BrowserCookie)
		}
	}
	j.mu.Unlock()
	j.saveMu.Lock()
	defer j.saveMu.Unlock()
	if version <= j.saved {
		return
	}
	j.saved = version
	j.persist(cookies)
}

// browserCookieDefaultPath is RFC 6265's default-path: the request path's
// directory.
func browserCookieDefaultPath(requestPath string) string {
	if !strings.HasPrefix(requestPath, "/") {
		return "/"
	}
	last := strings.LastIndex(requestPath, "/")
	if last == 0 {
		return "/"
	}
	return requestPath[:last]
}

func browserCookiePathMatch(requestPath, cookiePath string) bool {
	if requestPath == cookiePath {
		return true
	}
	return strings.HasPrefix(requestPath, cookiePath) &&
		(strings.HasSuffix(cookiePath, "/") || requestPath[len(cookiePath)] == '/')
}

func browserCookieSameSite(mode http.SameSite) string {
	switch mode {
	case http.SameSiteLaxMode:
		return "Lax"
	case http.SameSiteStrictMode:
		return "Strict"
	case http.SameSiteNoneMode:
		return "None"
	}
	return ""
}
