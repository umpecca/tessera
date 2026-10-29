package httpapi

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"tessera/internal/store"
)

// Browser pane site data (task 242): pages in a Browser pane have an opaque
// origin, so the browser refuses them localStorage, sessionStorage and
// cookies. Tessera keeps them instead. localStorage and cookies belong to the
// account and the development server's origin; sessionStorage to the pane
// and origin, in memory. The bootstrap's stand-ins (browser_site_data.js)
// load a page's data from /browser-proxy-state/<session id> before the page's
// own scripts run and send changes back there; the proxy sends and keeps the
// cookies itself.

const (
	browserProxyStatePrefix   = "/browser-proxy-state/"
	browserStorageQuota       = 5 << 20
	browserSessionStorageLife = 24 * time.Hour
	// JSON escaping can make a batch longer than the quota it fits in.
	browserStateBodyMax = 16 << 20
)

//go:embed browser_site_data.js
var browserSiteDataScript string

// browserSite is whose data a proxy session's pages see.
type browserSite struct {
	account string
	pane    string
	origin  string
	host    string
}

type browserSiteData struct {
	store *store.Store

	mu   sync.Mutex
	jars map[string]*browserCookieJar
	// memory holds sessionStorage, and localStorage when there is no store.
	memory map[string]*browserMemoryStorage
}

type browserMemoryStorage struct {
	mu    sync.Mutex
	items map[string]string
	size  int
	used  time.Time
}

func (a *API) siteData() *browserSiteData {
	a.browserSiteDataOnce.Do(func() {
		a.browserSiteData = &browserSiteData{store: a.Store, jars: map[string]*browserCookieJar{}, memory: map[string]*browserMemoryStorage{}}
	})
	return a.browserSiteData
}

func (d *browserSiteData) jar(site browserSite) *browserCookieJar {
	key := site.account + "\x00" + site.origin
	d.mu.Lock()
	defer d.mu.Unlock()
	if jar := d.jars[key]; jar != nil {
		return jar
	}
	var stored []store.BrowserCookie
	var persist func([]store.BrowserCookie)
	if d.store != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		cookies, err := d.store.BrowserCookies(ctx, site.account, site.origin)
		cancel()
		if err != nil {
			log.Printf("load browser cookies for %s: %v", site.origin, err)
		}
		stored = cookies
		persist = func(cookies []store.BrowserCookie) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := d.store.SaveBrowserCookies(ctx, site.account, site.origin, cookies); err != nil {
				log.Printf("save browser cookies for %s: %v", site.origin, err)
			}
		}
	}
	jar := newBrowserCookieJar(site.host, stored, persist)
	d.jars[key] = jar
	return jar
}

// memoryStorage returns the in-memory storage for key, dropping any unused
// for browserSessionStorageLife.
func (d *browserSiteData) memoryStorage(key string, now time.Time) *browserMemoryStorage {
	d.mu.Lock()
	defer d.mu.Unlock()
	for candidate, storage := range d.memory {
		storage.mu.Lock()
		stale := now.Sub(storage.used) > browserSessionStorageLife
		storage.mu.Unlock()
		if stale {
			delete(d.memory, candidate)
		}
	}
	storage := d.memory[key]
	if storage == nil {
		storage = &browserMemoryStorage{items: map[string]string{}}
		d.memory[key] = storage
	}
	storage.mu.Lock()
	storage.used = now
	storage.mu.Unlock()
	return storage
}

func (d *browserSiteData) sessionStorage(site browserSite, now time.Time) *browserMemoryStorage {
	return d.memoryStorage("session\x00"+site.account+"\x00"+site.pane+"\x00"+site.origin, now)
}

func (d *browserSiteData) localItems(ctx context.Context, site browserSite, now time.Time) (map[string]string, error) {
	if d.store != nil {
		return d.store.BrowserStorage(ctx, site.account, site.origin)
	}
	return d.memoryStorage("local\x00"+site.account+"\x00"+site.origin, now).snapshot(), nil
}

func (d *browserSiteData) applyLocal(ctx context.Context, site browserSite, ops []store.BrowserStorageOp, now time.Time) error {
	if d.store != nil {
		return d.store.ApplyBrowserStorage(ctx, site.account, site.origin, ops, browserStorageQuota)
	}
	return d.memoryStorage("local\x00"+site.account+"\x00"+site.origin, now).apply(ops, browserStorageQuota)
}

// clear removes a site's localStorage, cookies and this pane's
// sessionStorage.
func (d *browserSiteData) clear(ctx context.Context, site browserSite, now time.Time) error {
	d.jar(site).clear()
	_ = d.sessionStorage(site, now).apply([]store.BrowserStorageOp{{Op: "clear"}}, browserStorageQuota)
	if d.store != nil {
		return d.store.ClearBrowserSiteData(ctx, site.account, site.origin)
	}
	return d.memoryStorage("local\x00"+site.account+"\x00"+site.origin, now).apply([]store.BrowserStorageOp{{Op: "clear"}}, browserStorageQuota)
}

func (s *browserMemoryStorage) snapshot() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := make(map[string]string, len(s.items))
	for key, value := range s.items {
		items[key] = value
	}
	return items
}

// apply applies ops in order, all or none: none when the items would then
// come to more than quota.
func (s *browserMemoryStorage) apply(ops []store.BrowserStorageOp, quota int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Work out the size first, against an overlay of the changes.
	overlay := map[string]*string{}
	cleared := false
	size := s.size
	current := func(key string) (string, bool) {
		if value, ok := overlay[key]; ok {
			if value == nil {
				return "", false
			}
			return *value, true
		}
		if cleared {
			return "", false
		}
		value, ok := s.items[key]
		return value, ok
	}
	for _, op := range ops {
		switch op.Op {
		case "set":
			if old, ok := current(op.Key); ok {
				size -= store.BrowserStorageSize(op.Key, old)
			}
			value := op.Value
			overlay[op.Key] = &value
			size += store.BrowserStorageSize(op.Key, value)
		case "remove":
			if old, ok := current(op.Key); ok {
				size -= store.BrowserStorageSize(op.Key, old)
			}
			overlay[op.Key] = nil
		case "clear":
			overlay = map[string]*string{}
			cleared = true
			size = 0
		default:
			return errors.New("unknown browser storage operation")
		}
	}
	if size > quota {
		return store.ErrBrowserStorageQuota
	}
	if cleared {
		s.items = map[string]string{}
	}
	for key, value := range overlay {
		if value == nil {
			delete(s.items, key)
		} else {
			s.items[key] = *value
		}
	}
	s.size = size
	return nil
}

type browserStateOp struct {
	Store string `json:"s"`
	Op    string `json:"op,omitempty"`
	Key   string `json:"k,omitempty"`
	Value string `json:"v,omitempty"`
}

type browserStateRequest struct {
	Path string           `json:"path"`
	Ops  []browserStateOp `json:"ops"`
}

// browserProxyState serves the bootstrap's snapshot (GET, ?path= the page's
// path, &part=cookies for its cookies alone) and applies its changes (POST,
// text/plain JSON so no preflight is needed). The session ID is the
// capability, as for /browser-proxy/.
func (a *API) browserProxyState(w http.ResponseWriter, r *http.Request) {
	header := w.Header()
	clearProxySecurityHeaders(header)
	setBrowserProxyResponseHeaders(header)
	header.Set("Cache-Control", "no-store")
	session := a.proxyManager().get(strings.TrimPrefix(r.URL.Path, browserProxyStatePrefix))
	if session == nil || session.sites == nil {
		writeError(w, http.StatusNotFound, "browser proxy expired")
		return
	}
	sites, site, now := session.sites, session.site, time.Now()
	switch r.Method {
	case http.MethodGet:
		path := r.URL.Query().Get("path")
		cookies := sites.jar(site).scriptCookies(path, now)
		if r.URL.Query().Get("part") == "cookies" {
			writeJSON(w, http.StatusOK, map[string]string{"cookies": cookies})
			return
		}
		local, err := sites.localItems(r.Context(), site, now)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not load browser storage")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"local":   local,
			"session": sites.sessionStorage(site, now).snapshot(),
			"cookies": cookies,
		})
	case http.MethodPost:
		var request browserStateRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, browserStateBodyMax)).Decode(&request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid browser storage request")
			return
		}
		var local, sessionOps []store.BrowserStorageOp
		jar := sites.jar(site)
		for _, op := range request.Ops {
			switch op.Store {
			case "local":
				local = append(local, store.BrowserStorageOp{Op: op.Op, Key: op.Key, Value: op.Value})
			case "session":
				sessionOps = append(sessionOps, store.BrowserStorageOp{Op: op.Op, Key: op.Key, Value: op.Value})
			case "cookie":
				jar.setFromScript(request.Path, op.Value, now)
			}
		}
		var refused []string
		for _, part := range []struct {
			name  string
			apply func() error
		}{
			{"localStorage", func() error { return sites.applyLocal(r.Context(), site, local, now) }},
			{"sessionStorage", func() error {
				return sites.sessionStorage(site, now).apply(sessionOps, browserStorageQuota)
			}},
		} {
			if part.name == "localStorage" && len(local) == 0 || part.name == "sessionStorage" && len(sessionOps) == 0 {
				continue
			}
			err := part.apply()
			if errors.Is(err, store.ErrBrowserStorageQuota) {
				refused = append(refused, part.name)
			} else if err != nil {
				writeError(w, http.StatusBadRequest, "could not save browser storage")
				return
			}
		}
		cookies := jar.scriptCookies(request.Path, now)
		if len(refused) > 0 {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
				"error":   strings.Join(refused, " and ") + " quota exceeded",
				"cookies": cookies,
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"cookies": cookies})
	default:
		methodNotAllowed(w, "GET, POST")
	}
}
