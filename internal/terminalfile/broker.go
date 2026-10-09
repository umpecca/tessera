package terminalfile

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type Listener struct {
	Generation string
	Send       func(Event)
}

var ErrUnavailable = errors.New("request is unavailable")

type Transfer struct {
	ready                                                            bool
	Workspace, Pane, Epoch, ID, Operation, Directory, Client, Ticket string
	Paths                                                            []string
	Files                                                            []File
	Context                                                          context.Context
	cancel                                                           context.CancelFunc
	reply                                                            func(string)
	audience                                                         map[string]bool
	results                                                          map[int]File
	deadline                                                         time.Time
	last                                                             time.Time
	progress                                                         time.Time
	bytes                                                            int64
	active                                                           bool
	inflight                                                         bool
}
type Broker struct {
	mu        sync.Mutex
	requests  map[string]*Transfer
	tickets   map[string]*Transfer
	listeners map[string]map[string]Listener
	maxUpload int64
	closed    bool
	done      chan struct{}
}

func NewBroker() *Broker {
	b := &Broker{requests: map[string]*Transfer{}, tickets: map[string]*Transfer{}, listeners: map[string]map[string]Listener{}, maxUpload: 1 << 30, done: make(chan struct{})}
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				b.expire()
			case <-b.done:
				return
			}
		}
	}()
	return b
}
func scope(ws, pane, epoch string) string { return ws + "\x00" + pane + "\x00" + epoch }
func key(t *Transfer) string              { return scope(t.Workspace, t.Pane, t.Epoch) + "\x00" + t.ID }
func (b *Broker) SetMaxUpload(n int64) {
	if n <= 0 {
		n = 1 << 30
	}
	b.mu.Lock()
	b.maxUpload = n
	b.mu.Unlock()
}
func (b *Broker) Capabilities() Capabilities {
	b.mu.Lock()
	defer b.mu.Unlock()
	return Capabilities{1, Hostname(), runtime.GOOS, "host-local", true, true, MaxFiles, MaxMetadata, b.maxUpload, ApprovalTimeoutSeconds, IdleTimeoutSeconds}
}
func (b *Broker) Register(ws, pane, epoch, client, generation string, send func(Event)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := scope(ws, pane, epoch)
	if b.closed {
		return
	}
	if b.listeners[s] == nil {
		b.listeners[s] = map[string]Listener{}
	}
	b.listeners[s][client] = Listener{generation, send}
}
func (b *Broker) Detach(ws, pane, epoch, client, generation string, handoff bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := scope(ws, pane, epoch)
	l, ok := b.listeners[s][client]
	if !ok || l.Generation != generation {
		return
	}
	delete(b.listeners[s], client)
	if len(b.listeners[s]) == 0 {
		delete(b.listeners, s)
	}
	if handoff {
		time.AfterFunc(5*time.Second, func() {
			b.mu.Lock()
			defer b.mu.Unlock()
			if _, ok := b.listeners[s][client]; !ok {
				b.dropClientLocked(s, client)
			}
		})
	} else {
		b.dropClientLocked(s, client)
	}
}
func (b *Broker) dropClientLocked(s, client string) {
	for _, t := range b.requests {
		if scope(t.Workspace, t.Pane, t.Epoch) != s {
			continue
		}
		delete(t.audience, client)
		if t.Client == client || (t.Client == "" && len(t.audience) == 0) {
			b.finishLocked(t, Result{State: "cancelled", Error: "browser disconnected"})
		}
	}
}
func (b *Broker) Decline(ws, pane, epoch, id, client string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	t := b.requests[scope(ws, pane, epoch)+"\x00"+id]
	if t == nil || t.Client != "" || !t.audience[client] {
		return
	}
	delete(t.audience, client)
	if len(t.audience) == 0 {
		b.finishLocked(t, Result{State: "cancelled", Error: "no browser accepted the request"})
	}
}
func (b *Broker) CancelSession(ws, pane, epoch string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := scope(ws, pane, epoch)
	for _, t := range b.requests {
		if scope(t.Workspace, t.Pane, t.Epoch) == s {
			b.finishLocked(t, Result{State: "cancelled", Error: "terminal session ended or reset"})
		}
	}
}
func (b *Broker) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	close(b.done)
	for _, t := range b.requests {
		b.finishLocked(t, Result{State: "cancelled", Error: "server stopped"})
	}
	clear(b.listeners)
}

// Reserve capacity before filesystem checks; the PTY loop never waits for IO.
func (b *Broker) Handle(ws, pane, epoch string, c Command, reply func(string)) {
	if c.Action == "query" {
		reply(Prefix + "capabilities;" + c.ID + ";" + Encode(b.Capabilities()) + Terminator)
		return
	}
	if c.Action == "reset" {
		b.CancelSession(ws, pane, epoch)
		return
	}
	b.mu.Lock()
	t := &Transfer{Workspace: ws, Pane: pane, Epoch: epoch, ID: c.ID, Operation: c.Action, Directory: c.Directory, Paths: c.Paths, reply: reply, audience: map[string]bool{}, results: map[int]File{}, last: time.Now(), deadline: time.Now().Add(5 * time.Minute)}
	if c.Action == "cancel" {
		if old := b.requests[key(t)]; old != nil {
			b.finishLocked(old, Result{State: "cancelled"})
		}
		b.mu.Unlock()
		return
	}
	fail := func(msg string) { b.mu.Unlock(); reply(Reply(c.ID, Result{State: "failed", Error: msg})) }
	if c.Error != "" {
		fail(c.Error)
		return
	}
	if b.closed {
		fail("server stopped")
		return
	}
	if b.requests[key(t)] != nil {
		fail("duplicate request ID")
		return
	}
	count := 0
	for _, old := range b.requests {
		if scope(old.Workspace, old.Pane, old.Epoch) == scope(ws, pane, epoch) {
			count++
		}
	}
	if count >= 4 || len(b.requests) >= 32 {
		fail("too many file requests")
		return
	}
	for client := range b.listeners[scope(ws, pane, epoch)] {
		t.audience[client] = true
	}
	if len(t.audience) == 0 {
		fail("no-client")
		return
	}
	t.Context, t.cancel = context.WithCancel(context.Background())
	b.requests[key(t)] = t
	b.mu.Unlock()
	go b.prepare(t)
}
func (b *Broker) prepare(t *Transfer) {
	var files []File
	var failure string
	if t.Operation == "upload" {
		info, err := os.Stat(t.Directory)
		if err != nil {
			failure = err.Error()
		} else if !info.IsDir() {
			failure = "destination is not a directory"
		}
	} else {
		names := map[string]bool{}
		for _, path := range t.Paths {
			info, err := os.Stat(path)
			if err != nil {
				failure = err.Error()
				break
			}
			if !info.Mode().IsRegular() {
				failure = "source is not a regular file"
				break
			}
			name := filepath.Base(path)
			if !ValidName(name) {
				failure = "unsafe download basename"
				break
			}
			if names[name] {
				failure = "duplicate download basenames"
				break
			}
			names[name] = true
			files = append(files, File{Name: name, Path: path, Bytes: info.Size()})
		}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.requests[key(t)] != t {
		return
	}
	if failure != "" {
		b.finishLocked(t, Result{State: "failed", Error: failure})
		return
	}
	t.Files = files
	t.ready = true
	t.reply(Reply(t.ID, Result{State: "pending"}))
	event := Event{Type: "terminal-file", Epoch: t.Epoch, ID: t.ID, Action: "request", Operation: t.Operation, Directory: t.Directory, Files: files}
	for _, file := range files {
		event.Bytes += file.Bytes
	}
	for client := range t.audience {
		if l, ok := b.listeners[scope(t.Workspace, t.Pane, t.Epoch)][client]; ok {
			l.Send(event)
		}
	}
}
func ValidName(s string) bool {
	if s == "" || s == "." || s == ".." || filepath.IsAbs(s) || filepath.Base(s) != s || strings.ContainsAny(s, "/\\\x00") || len(s) > 4096 {
		return false
	}
	if runtime.GOOS == "windows" {
		if strings.ContainsAny(s, `<>:"|?*`) || strings.TrimRight(s, " .") != s {
			return false
		}
		stem := strings.ToUpper(strings.SplitN(s, ".", 2)[0])
		if stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" {
			return false
		}
		if len(stem) == 4 && (strings.HasPrefix(stem, "COM") || strings.HasPrefix(stem, "LPT")) && stem[3] >= '1' && stem[3] <= '9' {
			return false
		}
	}
	return true
}
func (b *Broker) Claim(ws, pane, epoch, id, client string, files []File) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	t := b.requests[scope(ws, pane, epoch)+"\x00"+id]
	if t == nil || !t.ready || t.Client != "" || !t.audience[client] {
		return "", ErrUnavailable
	}
	if _, ok := b.listeners[scope(ws, pane, epoch)][client]; !ok {
		return "", errors.New("browser is disconnected")
	}
	if t.Operation == "upload" {
		if len(files) < 1 || len(files) > MaxFiles {
			return "", errors.New("select 1–64 files")
		}
		names := map[string]bool{}
		for _, f := range files {
			if !ValidName(f.Name) || f.Bytes < 0 || f.Bytes > b.maxUpload || names[f.Name] {
				return "", errors.New("invalid upload name, size, or duplicate filename")
			}
			names[f.Name] = true
		}
		t.Files = make([]File, len(files))
		for i, f := range files {
			t.Files[i] = File{Name: f.Name, Bytes: f.Bytes}
		}
	}
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return "", err
	}
	t.Ticket = hex.EncodeToString(secret[:])
	t.Client = client
	t.last = time.Now()
	b.tickets[t.Ticket] = t
	b.broadcastLocked(t, Event{Type: "terminal-file", Epoch: t.Epoch, ID: t.ID, Action: "claimed"})
	t.reply(Reply(t.ID, Result{State: "claimed"}))
	return t.Ticket, nil
}

// Begin serializes body transfers; approval delays do not count as IO stalls.
func (b *Broker) Begin(ticket, operation string, indices ...int) (*Transfer, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	t := b.tickets[ticket]
	if t == nil || t.Operation != operation || t.inflight {
		return nil, errors.New("transfer ticket is unavailable")
	}
	if operation == "upload" {
		if len(indices) != 1 || indices[0] < 0 || indices[0] >= len(t.Files) {
			return nil, errors.New("invalid upload index")
		}
		if _, ok := t.results[indices[0]]; ok {
			return nil, errors.New("file already completed")
		}
	}
	t.inflight = true
	t.active = true
	t.last = time.Now()
	copy := *t
	copy.Files = append([]File(nil), t.Files...)
	copy.Paths = append([]string(nil), t.Paths...)
	return &copy, nil
}
func (b *Broker) Lookup(ticket string) (*Transfer, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	t := b.tickets[ticket]
	if t == nil {
		return nil, false
	}
	copy := *t
	copy.Files = append([]File(nil), t.Files...)
	copy.Paths = append([]string(nil), t.Paths...)
	return &copy, true
}
func (b *Broker) Progress(ticket string, n int64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	t := b.tickets[ticket]
	if t == nil {
		return false
	}
	t.bytes += n
	t.last = time.Now()
	if time.Since(t.progress) >= time.Second {
		t.progress = time.Now()
		t.reply(Reply(t.ID, Result{State: "transferring", Bytes: t.bytes}))
		b.broadcastLocked(t, Event{Type: "terminal-file", Epoch: t.Epoch, ID: t.ID, Action: "progress", Bytes: t.bytes})
	}
	return true
}
func (b *Broker) Record(ticket string, index int, file File) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	t := b.tickets[ticket]
	if t == nil || index < 0 || index >= len(t.Files) {
		return errors.New("transfer is unavailable")
	}
	if t.inflight && file.Status != "uploaded" {
		return errors.New("file transfer is still active")
	}
	if _, ok := t.results[index]; ok {
		return errors.New("file already completed")
	}
	if len(file.Error) > 512 {
		file.Error = file.Error[:512]
	}
	t.results[index] = file
	t.inflight = false
	t.active = false
	t.deadline = time.Now().Add(5 * time.Minute)
	return nil
}
func (b *Broker) Pause(ticket string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if t := b.tickets[ticket]; t != nil {
		t.inflight = false
		t.active = false
		t.deadline = time.Now().Add(5 * time.Minute)
	}
}
func (b *Broker) Finish(ticket, state, message string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	t := b.tickets[ticket]
	if t == nil {
		return errors.New("transfer is unavailable")
	}
	result := Result{State: state, Error: message, Bytes: t.bytes}
	if t.Operation == "upload" && state == "complete" {
		for i := range t.Files {
			f, ok := t.results[i]
			if !ok {
				return errors.New("batch still has unfinished files")
			}
			result.Files = append(result.Files, f)
			if f.Status != "uploaded" {
				result.State = "partial"
			}
		}
	} else {
		result.Files = append([]File(nil), t.Files...)
	}
	b.finishLocked(t, result)
	return nil
}
func (b *Broker) broadcastLocked(t *Transfer, event Event) {
	for _, l := range b.listeners[scope(t.Workspace, t.Pane, t.Epoch)] {
		l.Send(event)
	}
}
func (b *Broker) finishLocked(t *Transfer, result Result) {
	if b.requests[key(t)] != t {
		return
	}
	delete(b.requests, key(t))
	delete(b.tickets, t.Ticket)
	t.cancel()
	if t.Operation == "upload" {
		result.Directory = t.Directory
	}
	if len(result.Files) == 0 && t.Operation == "upload" {
		for i := range t.Files {
			if f, ok := t.results[i]; ok {
				result.Files = append(result.Files, f)
			}
		}
	}
	t.reply(Reply(t.ID, result))
	b.broadcastLocked(t, Event{Type: "terminal-file", Epoch: t.Epoch, ID: t.ID, Action: "finished", Error: result.Error})
}
func (b *Broker) expire() {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	for _, t := range b.requests {
		if (!t.active && now.After(t.deadline)) || (t.active && now.Sub(t.last) > 2*time.Minute) {
			b.finishLocked(t, Result{State: "failed", Error: "file transfer timed out", Bytes: t.bytes})
		}
	}
}
