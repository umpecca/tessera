package auth

import (
	"sync"
	"time"
)

const (
	freeFailures      = 3
	firstBackoff      = 2 * time.Second
	maxBackoff        = 15 * time.Minute
	globalPerMinute   = 10
	maxThrottledPeers = 10000
	throttleIdle      = time.Hour
)

// Throttle slows password guessing: each client gets a few free failures,
// then exponential backoff, and all clients together share a per-minute cap.
type Throttle struct {
	mu      sync.Mutex
	clients map[string]*throttleClient
	recent  []time.Time
}

type throttleClient struct {
	failures int
	until    time.Time
	seen     time.Time
}

func NewThrottle() *Throttle {
	return &Throttle{clients: map[string]*throttleClient{}}
}

// Begin reserves a verification for client, or reports how long to wait.
func (t *Throttle) Begin(client string, now time.Time) time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()
	if entry := t.clients[client]; entry != nil && now.Before(entry.until) {
		return entry.until.Sub(now)
	}
	cutoff := now.Add(-time.Minute)
	kept := t.recent[:0]
	for _, at := range t.recent {
		if at.After(cutoff) {
			kept = append(kept, at)
		}
	}
	t.recent = kept
	if len(t.recent) >= globalPerMinute {
		return t.recent[0].Add(time.Minute).Sub(now)
	}
	t.recent = append(t.recent, now)
	return 0
}

func (t *Throttle) Failure(client string, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	entry := t.clients[client]
	if entry == nil {
		t.evictLocked(now)
		entry = &throttleClient{}
		t.clients[client] = entry
	}
	entry.failures++
	entry.seen = now
	if entry.failures > freeFailures {
		delay := firstBackoff << min(entry.failures-freeFailures-1, 20)
		entry.until = now.Add(min(delay, maxBackoff))
	}
}

func (t *Throttle) Success(client string) {
	t.mu.Lock()
	delete(t.clients, client)
	t.mu.Unlock()
}

func (t *Throttle) evictLocked(now time.Time) {
	for key, entry := range t.clients {
		if now.Sub(entry.seen) > throttleIdle && !now.Before(entry.until) {
			delete(t.clients, key)
		}
	}
	for len(t.clients) >= maxThrottledPeers {
		var oldestKey string
		var oldest time.Time
		for key, entry := range t.clients {
			if oldestKey == "" || entry.seen.Before(oldest) {
				oldestKey, oldest = key, entry.seen
			}
		}
		delete(t.clients, oldestKey)
	}
}
