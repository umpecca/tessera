package httpapi

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"sync"
	"time"

	"tessera/internal/store"
)

const certificateNamesTTL = 30 * time.Second

// hostAllowlist defends against DNS rebinding: a hostile page whose own domain
// is made to resolve to this machine sends requests with that domain as the
// Host. IP literals cannot be rebound, so only DNS names are checked: the
// machine's own names, localhost, the Local HTTPS certificate's names, and
// -allowed-host.
type hostAllowlist struct {
	store         *store.Store
	defaultAddr   string
	configured    map[string]bool
	machine       map[string]bool
	mu            sync.Mutex
	certNames     map[string]bool
	certNamesRead time.Time
	warned        map[string]bool
}

func newHostAllowlist(st *store.Store, defaultAddr string, configured []string) *hostAllowlist {
	list := &hostAllowlist{store: st, defaultAddr: defaultAddr, configured: map[string]bool{}, machine: map[string]bool{}, warned: map[string]bool{}}
	for _, name := range configured {
		if name = normalizeHostName(name); name != "" {
			list.configured[name] = true
		}
	}
	if hostname, err := os.Hostname(); err == nil {
		hostname = normalizeHostName(hostname)
		short := strings.TrimSuffix(hostname, ".local")
		for _, name := range []string{hostname, short, short + ".local"} {
			if name != "" && name != ".local" {
				list.machine[name] = true
			}
		}
	}
	return list
}

// normalizeHostName lowercases a host, drops any port and trailing dot, and
// strips IPv6 brackets.
func normalizeHostName(host string) string {
	host = strings.TrimSpace(strings.ToLower(host))
	if name, _, err := net.SplitHostPort(host); err == nil {
		host = name
	}
	return strings.TrimSuffix(strings.Trim(host, "[]"), ".")
}

func (l *hostAllowlist) allowed(ctx context.Context, host string) bool {
	name := normalizeHostName(host)
	if name == "" {
		return false
	}
	if _, err := netip.ParseAddr(name); err == nil {
		return true
	}
	if name == "localhost" || strings.HasSuffix(name, ".localhost") || l.configured[name] || l.machine[name] {
		return true
	}
	return l.certificateName(ctx, name)
}

func (l *hostAllowlist) certificateName(ctx context.Context, name string) bool {
	if l.store == nil {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if time.Since(l.certNamesRead) > certificateNamesTTL {
		l.certNames = map[string]bool{}
		if config, err := l.store.LoadLocalHTTPSConfig(ctx, l.defaultAddr); err == nil {
			for _, certName := range config.DNSNames {
				l.certNames[normalizeHostName(certName)] = true
			}
		}
		l.certNamesRead = time.Now()
	}
	return l.certNames[name]
}

// refuse answers 421 and logs each refused name once, so an operator who
// reaches Tessera by a new name learns which flag to add.
func (l *hostAllowlist) refuse(w http.ResponseWriter, host string) {
	name := normalizeHostName(host)
	l.mu.Lock()
	first := !l.warned[name] && len(l.warned) < 256
	if first {
		l.warned[name] = true
	}
	l.mu.Unlock()
	if first {
		log.Printf("refused requests for unrecognized host name %q; if you reach Tessera by that name, restart with -allowed-host %s", name, name)
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusMisdirectedRequest)
	fmt.Fprintf(w, "Tessera does not recognize the name %q.\n\nIf this is how you reach Tessera, restart it with: -allowed-host %s\n", name, name)
}
