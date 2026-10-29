package httpapi

import (
	"context"
	"log"
	"time"

	"github.com/gorilla/websocket"

	"tessera/internal/store"
)

const (
	// signInEndedCloseCode tells the browser a socket closed because its
	// sign-in ended, so it asks to sign in again instead of reconnecting.
	signInEndedCloseCode = 4401
)

// signInWatchInterval is how often open connections' sign-ins are checked
// for expiry or account changes. A variable so tests can shorten it.
var signInWatchInterval = 30 * time.Second

type gateKey struct{}

// unsignedWatch collects connections opened while sign-in was off, which
// close when it is turned on.
const unsignedWatch = "(no sign-in)"

type signInWatch struct {
	// id is the sign-in the connection belongs to; it changes when the
	// sign-in is replaced, as when its account's password changes.
	id  string
	end func()
}

// WatchSignIn runs end once if the request's sign-in ends while a long-lived
// connection is open. The returned stop must be called when the connection
// closes. Without the sign-in gate it does nothing.
func WatchSignIn(ctx context.Context, end func()) (stop func()) {
	gate, _ := ctx.Value(gateKey{}).(*authGate)
	if gate == nil {
		return func() {}
	}
	if signIn, ok := ctx.Value(signInKey{}).(store.SignIn); ok {
		return gate.watch(signIn.ID, end)
	}
	return gate.watch(unsignedWatch, end)
}

// closeOnSignInEnd closes a websocket with signInEndedCloseCode when the
// request's sign-in ends. WriteControl and Close are safe to call alongside
// the connection's other writers.
func closeOnSignInEnd(ctx context.Context, conn *websocket.Conn) (stop func()) {
	return WatchSignIn(ctx, func() {
		message := websocket.FormatCloseMessage(signInEndedCloseCode, "sign-in ended")
		_ = conn.WriteControl(websocket.CloseMessage, message, time.Now().Add(time.Second))
		_ = conn.Close()
	})
}

func (g *authGate) watch(id string, end func()) func() {
	if id == "" {
		return func() {}
	}
	entry := &signInWatch{id: id, end: end}
	g.watchMu.Lock()
	if g.watches[id] == nil {
		g.watches[id] = map[*signInWatch]struct{}{}
	}
	g.watches[id][entry] = struct{}{}
	if !g.watching {
		g.watching = true
		go g.checkWatched()
	}
	g.watchMu.Unlock()
	return func() {
		g.watchMu.Lock()
		delete(g.watches[entry.id], entry)
		if len(g.watches[entry.id]) == 0 {
			delete(g.watches, entry.id)
		}
		g.watchMu.Unlock()
	}
}

// moveWatches hands one sign-in's open connections to its replacement, so
// they stay open when the old one ends.
func (g *authGate) moveWatches(from, to string) {
	g.watchMu.Lock()
	defer g.watchMu.Unlock()
	for entry := range g.watches[from] {
		entry.id = to
		if g.watches[to] == nil {
			g.watches[to] = map[*signInWatch]struct{}{}
		}
		g.watches[to][entry] = struct{}{}
	}
	delete(g.watches, from)
}

// endSignIns closes every connection opened under the given sign-ins.
func (g *authGate) endSignIns(ids ...string) {
	var ends []func()
	g.watchMu.Lock()
	for _, id := range ids {
		for entry := range g.watches[id] {
			ends = append(ends, entry.end)
		}
		delete(g.watches, id)
	}
	g.watchMu.Unlock()
	for _, end := range ends {
		go end()
	}
}

func (g *authGate) endAllWatched() {
	g.watchMu.Lock()
	ids := make([]string, 0, len(g.watches))
	for id := range g.watches {
		ids = append(ids, id)
	}
	g.watchMu.Unlock()
	g.endSignIns(ids...)
}

// checkWatched re-validates sign-ins with open connections, catching expiry
// and password changes or removals made with `tessera user` while the
// server ran. While sign-in is off every connection may stay. It stops when
// nothing is watched.
func (g *authGate) checkWatched() {
	ticker := time.NewTicker(signInWatchInterval)
	defer ticker.Stop()
	for range ticker.C {
		g.watchMu.Lock()
		if len(g.watches) == 0 {
			g.watching = false
			g.watchMu.Unlock()
			return
		}
		ids := make([]string, 0, len(g.watches))
		for id := range g.watches {
			ids = append(ids, id)
		}
		g.watchMu.Unlock()
		if g.mode() == AuthOff {
			continue
		}
		var ended []string
		for _, id := range ids {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			signIn, err := g.store.SignInByID(ctx, id, g.now())
			cancel()
			if err != nil || !g.accountCurrent(signIn) {
				ended = append(ended, id)
			}
		}
		if len(ended) > 0 {
			log.Printf("closing connections for %d ended sign-ins", len(ended))
			g.endSignIns(ended...)
			g.auditEnded(ended)
		}
	}
}

// auditEnded records connections closed because their sign-in expired or its
// account changed; no request carries these.
func (g *authGate) auditEnded(ids []string) {
	if g.opts.AuditRetention <= 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, id := range ids {
		err := g.store.RecordAuditEvent(ctx, store.AuditEvent{
			OccurredAt: now, RequestID: newRequestID(), Method: "-", Path: "(sign-in ended)",
			Status: signInEndedCloseCode, Outcome: "expired", SignInID: id,
		}, g.opts.AuditRetention)
		if err != nil {
			log.Printf("audit ended sign-in: %v", err)
		}
	}
}
