package terminalfile

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func offered(t *testing.T, b *Broker, c Command, reply func(string)) chan Event {
	t.Helper()
	events := make(chan Event, 256)
	b.Register("ws", "pane", "epoch", "client", "generation", func(e Event) { events <- e })
	b.Handle("ws", "pane", "epoch", c, reply)
	select {
	case e := <-events:
		if e.Action != "request" {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Fatal("no offer")
	}
	return events
}
func TestClaimsCancelAndHandoff(t *testing.T) {
	b := NewBroker()
	defer b.Close()
	replies := make(chan string, 32)
	events := offered(t, b, Command{Action: "upload", ID: "one", Directory: t.TempDir()}, func(s string) { replies <- s })
	b.Register("ws", "pane", "epoch", "other", "g", func(Event) {})
	if _, err := b.Claim("ws", "pane", "epoch", "one", "other", []File{{Name: "a", Bytes: 2}}); err == nil {
		t.Fatal("late listener claimed historical request")
	}
	ticket, err := b.Claim("ws", "pane", "epoch", "one", "client", []File{{Name: "a", Bytes: 2}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.Claim("ws", "pane", "epoch", "one", "client", []File{{Name: "a", Bytes: 2}}); err == nil {
		t.Fatal("duplicate claim")
	}
	b.Detach("ws", "pane", "epoch", "client", "generation", true)
	b.Register("ws", "pane", "epoch", "client", "new-generation", func(e Event) { events <- e })
	if _, ok := b.Lookup(ticket); !ok {
		t.Fatal("handoff lost active transfer")
	}
	b.Detach("ws", "pane", "epoch", "client", "generation", false)
	if _, ok := b.Lookup(ticket); !ok {
		t.Fatal("stale detach cancelled replacement")
	}
	tr, err := b.Begin(ticket, "upload", 0)
	if err != nil {
		t.Fatal(err)
	}
	b.Detach("ws", "pane", "epoch", "client", "new-generation", false)
	select {
	case <-tr.Context.Done():
	default:
		t.Fatal("disconnect did not cancel IO")
	}
	if _, ok := b.Lookup(ticket); ok {
		t.Fatal("ticket outlived client")
	}
}
func TestCompetingClientsAndBatchCompletion(t *testing.T) {
	b := NewBroker()
	defer b.Close()
	events := make(chan Event, 32)
	replies := make(chan string, 32)
	for _, client := range []string{"a", "b"} {
		b.Register("ws", "p", "e", client, client, func(e Event) { events <- e })
	}
	b.Handle("ws", "p", "e", Command{Action: "upload", ID: "id", Directory: t.TempDir()}, func(s string) { replies <- s })
	for range 2 {
		select {
		case <-events:
		case <-time.After(time.Second):
			t.Fatal("no request")
		}
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var winners []string
	for _, client := range []string{"a", "b"} {
		wg.Go(func() {
			ticket, err := b.Claim("ws", "p", "e", "id", client, []File{{Name: "a", Bytes: 1}, {Name: "b", Bytes: 2}})
			if err == nil {
				mu.Lock()
				winners = append(winners, ticket)
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	if len(winners) != 1 {
		t.Fatal(winners)
	}
	ticket := winners[0]
	if b.Finish(ticket, "complete", "") == nil {
		t.Fatal("unfinished batch succeeded")
	}
	if _, err := b.Begin(ticket, "upload", 0); err != nil {
		t.Fatal(err)
	}
	if b.Record(ticket, 0, File{Name: "a", Status: "failed"}) == nil {
		t.Fatal("client changed an active file")
	}
	if err := b.Record(ticket, 0, File{Name: "a", Status: "uploaded", Bytes: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Begin(ticket, "upload", 0); err == nil {
		t.Fatal("replayed upload")
	}
	if err := b.Record(ticket, 1, File{Name: "b", Status: "skipped"}); err != nil {
		t.Fatal(err)
	}
	if err := b.Finish(ticket, "complete", ""); err != nil {
		t.Fatal(err)
	}
	for len(replies) > 0 {
		s := <-replies
		if data, ok := MatchReply([]byte(s), "reply", "id"); ok && string(data) == "" {
			t.Fatal("empty result")
		}
	}
}
func TestBoundsNoClientTimeoutAndInvalidFiles(t *testing.T) {
	b := NewBroker()
	defer b.Close()
	replies := make(chan string, 64)
	b.Handle("w", "p", "e", Command{Action: "upload", ID: "none", Directory: t.TempDir()}, func(s string) { replies <- s })
	if s := <-replies; !contains(s, "no-client") {
		t.Fatal(s)
	}
	offered(t, b, Command{Action: "upload", ID: "timeout", Directory: t.TempDir()}, func(s string) { replies <- s })
	b.mu.Lock()
	for _, tr := range b.requests {
		tr.deadline = time.Now().Add(-time.Second)
	}
	b.mu.Unlock()
	b.expire()
	b.mu.Lock()
	if len(b.requests) != 0 {
		t.Fatal("deadline leaked request")
	}
	b.mu.Unlock()
	root := t.TempDir()
	file := filepath.Join(root, "a")
	_ = os.WriteFile(file, []byte("a"), 0600)
	b.Register("w", "p", "e", "c", "g", func(Event) {})
	b.Handle("w", "p", "e", Command{Action: "download", ID: "duplicate", Paths: []string{file, file}}, func(s string) { replies <- s })
	select {
	case s := <-replies:
		_ = s
	case <-time.After(time.Second):
		t.Fatal("invalid source unanswered")
	}
}
func contains(s, expected string) bool {
	data, ok := MatchReply([]byte(s), "reply", "none")
	return ok && string(data) == `{"state":"failed","error":"`+expected+`"}`
}

func TestServerAndTerminalRequestLimitsAndIdleTimeout(t *testing.T) {
	b := NewBroker()
	defer b.Close()
	directory := t.TempDir()
	for n := range 32 {
		pane := fmt.Sprintf("p%d", n/4)
		b.Register("w", pane, "e", "c", "g", func(Event) {})
		b.Handle("w", pane, "e", Command{Action: "upload", ID: fmt.Sprintf("id%d", n), Directory: directory}, func(string) {})
	}
	b.mu.Lock()
	count := len(b.requests)
	b.mu.Unlock()
	if count != 32 {
		t.Fatal(count)
	}
	replies := make(chan string, 8)
	b.Register("w", "extra", "e", "c", "g", func(Event) {})
	b.Handle("w", "extra", "e", Command{Action: "upload", ID: "full", Directory: directory}, func(s string) { replies <- s })
	data, ok := MatchReply([]byte(<-replies), "reply", "full")
	if !ok || !strings.Contains(string(data), "too many") {
		t.Fatal(string(data))
	}
	b.mu.Lock()
	for _, tr := range b.requests {
		tr.active = true
		tr.last = time.Now().Add(-3 * time.Minute)
	}
	b.mu.Unlock()
	b.expire()
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.requests) != 0 {
		t.Fatal("idle transfers retained capacity")
	}
}
