package terminal

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

type pidTestPTY struct{ pid int }

func (p *pidTestPTY) Read([]byte) (int, error)       { return 0, io.EOF }
func (p *pidTestPTY) Write(data []byte) (int, error) { return len(data), nil }
func (p *pidTestPTY) Resize(int, int) error          { return nil }
func (p *pidTestPTY) Close() error                   { return nil }
func (p *pidTestPTY) PID() int                       { return p.pid }
func (p *pidTestPTY) Wait() error                    { return nil }

type writeTestPTY struct{ bytes.Buffer }

func (p *writeTestPTY) Read([]byte) (int, error) { return 0, io.EOF }
func (p *writeTestPTY) Resize(int, int) error    { return nil }
func (p *writeTestPTY) Close() error             { return nil }
func (p *writeTestPTY) PID() int                 { return 1 }
func (p *writeTestPTY) Wait() error              { return nil }

type errorTestPTY struct{ err error }

func (p *errorTestPTY) Read([]byte) (int, error)       { return 0, p.err }
func (p *errorTestPTY) Write(data []byte) (int, error) { return len(data), nil }
func (p *errorTestPTY) Resize(int, int) error          { return nil }
func (p *errorTestPTY) Close() error                   { return nil }
func (p *errorTestPTY) PID() int                       { return 1 }
func (p *errorTestPTY) Wait() error                    { return nil }

// Stands in for Windows ConPTY, whose read side stays parked after the
// shell is gone.
type blockingTestPTY struct {
	closed    chan struct{}
	closeOnce sync.Once
}

func (p *blockingTestPTY) Read([]byte) (int, error) { <-p.closed; return 0, io.EOF }
func (p *blockingTestPTY) Write(d []byte) (int, error) {
	return len(d), nil
}
func (p *blockingTestPTY) Resize(int, int) error { return nil }
func (p *blockingTestPTY) PID() int              { return 1 }
func (p *blockingTestPTY) Wait() error           { return nil }
func (p *blockingTestPTY) Close() error {
	p.closeOnce.Do(func() { close(p.closed) })
	return nil
}

func TestProcessWatcherEndsASessionWhosePTYStaysReadable(t *testing.T) {
	pty := &blockingTestPTY{closed: make(chan struct{})}
	session := &Session{pty: pty, done: make(chan error, 1)}
	managed := &ManagedSession{session: session, subscribers: map[*subscriber]struct{}{}}
	attachment := managed.subscribe(Cursor{})
	events, unsubscribe := attachment.Events, attachment.Unsubscribe
	defer unsubscribe()

	go managed.watchProcess()
	session.done <- nil

	select {
	case _, open := <-events:
		if open {
			t.Fatal("expected the subscriber channel to close, not to carry a chunk")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a shell that exited behind a still-readable PTY never ended the session")
	}
	exited, err := managed.Exited()
	if !exited || err != nil {
		t.Fatalf("Exited() = (%v, %v), want (true, nil)", exited, err)
	}
}

func TestReadLoopReportsAShellThatEndedOnItsOwn(t *testing.T) {
	managed := &ManagedSession{
		session:     &Session{pty: &pidTestPTY{pid: 7}},
		subscribers: map[*subscriber]struct{}{},
	}

	managed.readLoop()

	exited, err := managed.Exited()
	if !exited {
		t.Fatal("a shell that reached EOF was not reported as exited")
	}
	if err != nil {
		t.Fatalf("exit error = %v, want nil for a clean end", err)
	}
}

func TestReadLoopCarriesTheErrorThatEndedTheShell(t *testing.T) {
	failure := errors.New("read /dev/ptmx: input/output error")
	managed := &ManagedSession{
		session:     &Session{pty: &errorTestPTY{err: failure}},
		subscribers: map[*subscriber]struct{}{},
	}

	managed.readLoop()

	exited, err := managed.Exited()
	if !exited {
		t.Fatal("a failed read did not report an exit")
	}
	if !errors.Is(err, failure) {
		t.Fatalf("exit error = %v, want %v", err, failure)
	}
}

// Closing a pane or shutting the server down ends the PTY too, which wakes
// the read loop. That must not look like the shell exiting, or a browser
// riding out a restart would stop reconnecting.
func TestATerminatedSessionIsNotAnExit(t *testing.T) {
	managed := &ManagedSession{
		session:     &Session{pty: &pidTestPTY{pid: 7}},
		subscribers: map[*subscriber]struct{}{},
	}

	managed.Close()
	managed.readLoop()

	if exited, _ := managed.Exited(); exited {
		t.Fatal("a host-terminated session was reported as an exited shell")
	}
}

func newTestSession(limit int) *ManagedSession {
	return &ManagedSession{
		subscribers: map[*subscriber]struct{}{},
		scrollback:  scrollbackBuffer{limit: limit},
	}
}

func receiveChunk(t *testing.T, events <-chan []byte) ([]byte, bool) {
	t.Helper()
	select {
	case chunk, open := <-events:
		return chunk, open
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for terminal output")
		return nil, false
	}
}

// The fan-out used to drop a chunk whenever a client's buffer was full,
// which no client could detect. Everything published while a reader is
// behind must still arrive, in order.
func TestASlowClientStillReceivesEveryChunkInOrder(t *testing.T) {
	session := newTestSession(1 << 20)
	attachment := session.subscribe(Cursor{})
	events, unsubscribe := attachment.Events, attachment.Unsubscribe
	defer unsubscribe()

	const chunks = 500
	go func() {
		for i := 0; i < chunks; i++ {
			session.publish([]byte(fmt.Sprintf("chunk %03d;", i)))
		}
	}()

	for i := 0; i < chunks; i++ {
		chunk, open := receiveChunk(t, events)
		if !open {
			t.Fatalf("channel closed after %d of %d chunks", i, chunks)
		}
		if want := fmt.Sprintf("chunk %03d;", i); string(chunk) != want {
			t.Fatalf("chunk %d = %q, want %q", i, chunk, want)
		}
	}
}

// The read loop serves every client at once, so it must not be parked on
// the slowest of them.
func TestPublishingDoesNotWaitForAClientThatIsNotReading(t *testing.T) {
	session := newTestSession(1 << 20)
	attachment := session.subscribe(Cursor{})
	events, unsubscribe := attachment.Events, attachment.Unsubscribe
	defer unsubscribe()
	_ = events

	done := make(chan struct{})
	go func() {
		for i := 0; i < 200; i++ {
			session.publish([]byte("output that nobody is collecting"))
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("publishing blocked on a client that stopped reading")
	}
}

// Past that point the client has lost more than the scrollback would hold,
// so it is disconnected: the browser notices a closed socket and resumes,
// where it could never notice missing bytes.
func TestAClientThatFallsTooFarBehindIsDisconnected(t *testing.T) {
	session := newTestSession(600)
	attachment := session.subscribe(Cursor{})
	events, unsubscribe := attachment.Events, attachment.Unsubscribe
	defer unsubscribe()

	for i := 0; i < 40; i++ {
		session.publish([]byte(strings.Repeat("x", 100)))
	}

	for {
		chunk, open := receiveChunk(t, events)
		if !open {
			break
		}
		if len(chunk) != 100 {
			t.Fatalf("unexpected chunk of %d bytes", len(chunk))
		}
	}

	// The session is unharmed: a fresh client attaches and sees output.
	secondAttachment := session.subscribe(Cursor{})
	second, stop := secondAttachment.Events, secondAttachment.Unsubscribe
	defer stop()
	session.publish([]byte("still running"))
	chunk, open := receiveChunk(t, second)
	if !open || string(chunk) != "still running" {
		t.Fatalf("second client got (%q, open=%v)", chunk, open)
	}
}

func TestUnsubscribingReleasesAPumpParkedOnAStalledClient(t *testing.T) {
	session := newTestSession(1 << 20)
	attachment := session.subscribe(Cursor{})
	events, unsubscribe := attachment.Events, attachment.Unsubscribe
	session.publish([]byte("queued for a reader that never came"))

	unsubscribe()

	if _, open := receiveChunk(t, events); open {
		// A delivered chunk is fine, but the channel must still close.
		if _, stillOpen := receiveChunk(t, events); stillOpen {
			t.Fatal("channel stayed open after unsubscribe")
		}
	}
}

// A session that ends still owes its clients whatever the shell printed.
func TestQueuedOutputIsDeliveredBeforeTheSessionCloses(t *testing.T) {
	session := newTestSession(1 << 20)
	attachment := session.subscribe(Cursor{})
	events, unsubscribe := attachment.Events, attachment.Unsubscribe
	defer unsubscribe()

	session.publish([]byte("first"))
	session.publish([]byte("second"))
	session.finish()

	var received []string
	for {
		chunk, open := receiveChunk(t, events)
		if !open {
			break
		}
		received = append(received, string(chunk))
	}
	if len(received) != 2 || received[0] != "first" || received[1] != "second" {
		t.Fatalf("received %q, want the queued output before the close", received)
	}
}

func publishedSession(t *testing.T, limit int, chunks ...string) *ManagedSession {
	t.Helper()
	session := newTestSession(limit)
	session.epoch = "epoch-1"
	for _, chunk := range chunks {
		session.publish([]byte(chunk))
	}
	return session
}

// A first attach has nothing to continue from, so it gets everything and is
// told to start clean — exactly what every attach used to get.
func TestAClientWithNoCursorGetsTheWholeScrollback(t *testing.T) {
	session := publishedSession(t, 1<<20, "hello ", "world")
	attachment := session.subscribe(Cursor{})
	defer attachment.Unsubscribe()

	if string(attachment.Replay) != "hello world" {
		t.Fatalf("replay = %q, want the whole scrollback", attachment.Replay)
	}
	if !attachment.Reset {
		t.Fatal("a client starting from nothing was not told to reset")
	}
	if attachment.Offset != 0 {
		t.Fatalf("offset = %d, want 0 for a replay from the start", attachment.Offset)
	}
	if attachment.Epoch != "epoch-1" {
		t.Fatalf("epoch = %q", attachment.Epoch)
	}
}

// The point of the exercise: a client that missed a little is sent a little.
func TestAResumingClientIsSentOnlyWhatItMissed(t *testing.T) {
	session := publishedSession(t, 1<<20, "already seen;", "missed this")
	attachment := session.subscribe(Cursor{Epoch: "epoch-1", Offset: int64(len("already seen;"))})
	defer attachment.Unsubscribe()

	if string(attachment.Replay) != "missed this" {
		t.Fatalf("replay = %q, want only the missed tail", attachment.Replay)
	}
	if attachment.Reset {
		t.Fatal("a continuing client was told to throw away what it has")
	}
	if want := int64(len("already seen;")); attachment.Offset != want {
		t.Fatalf("offset = %d, want %d", attachment.Offset, want)
	}
}

// The common case after a brief blip: nothing happened while it was away.
func TestAClientThatMissedNothingIsSentNothing(t *testing.T) {
	session := publishedSession(t, 1<<20, "all of it")
	attachment := session.subscribe(Cursor{Epoch: "epoch-1", Offset: int64(len("all of it"))})
	defer attachment.Unsubscribe()

	if len(attachment.Replay) != 0 {
		t.Fatalf("replay = %q, want nothing", attachment.Replay)
	}
	if attachment.Reset {
		t.Fatal("a client that was already current was told to reset")
	}
}

// A shell that died and was replaced produces a different stream, so the old
// position means nothing in it.
func TestACursorFromAnotherSessionIsRefused(t *testing.T) {
	session := publishedSession(t, 1<<20, "fresh shell output")
	attachment := session.subscribe(Cursor{Epoch: "a-previous-shell", Offset: 5})
	defer attachment.Unsubscribe()

	if !attachment.Reset || string(attachment.Replay) != "fresh shell output" {
		t.Fatalf("stale epoch gave (reset=%v, replay=%q)", attachment.Reset, attachment.Replay)
	}
}

// Once the missing span has been trimmed off the back of the ring, resuming
// would leave a hole, so the client starts over instead.
func TestACursorThatFellOffTheScrollbackIsRefused(t *testing.T) {
	session := publishedSession(t, 16, "0123456789", "abcdefghij")
	attachment := session.subscribe(Cursor{Epoch: "epoch-1", Offset: 2})
	defer attachment.Unsubscribe()

	if !attachment.Reset {
		t.Fatal("a cursor older than the retained window was accepted")
	}
	// Offset still describes where the replay starts, so the client stays in
	// step even after starting over.
	if want := session.published - int64(len(attachment.Replay)); attachment.Offset != want {
		t.Fatalf("offset = %d, want %d", attachment.Offset, want)
	}
}

func TestAnImpossibleCursorIsRefused(t *testing.T) {
	session := publishedSession(t, 1<<20, "short")
	ahead := session.subscribe(Cursor{Epoch: "epoch-1", Offset: 9999})
	defer ahead.Unsubscribe()
	if !ahead.Reset {
		t.Fatal("a cursor past everything published was accepted")
	}
}

// Trimming the front of the scrollback must not move anyone's position.
func TestPublishedOffsetsSurviveScrollbackTrimming(t *testing.T) {
	session := publishedSession(t, 8, "aaaaaaaa", "bbbbbbbb", "cccccccc")
	if session.published != 24 {
		t.Fatalf("published = %d, want 24 regardless of trimming", session.published)
	}
	attachment := session.subscribe(Cursor{Epoch: "epoch-1", Offset: 16})
	defer attachment.Unsubscribe()
	if string(attachment.Replay) != "cccccccc" || attachment.Reset {
		t.Fatalf("resume after trimming gave (reset=%v, replay=%q)", attachment.Reset, attachment.Replay)
	}
}

func TestManagedSessionScrollbackReplayAndSubscribe(t *testing.T) {
	session := &ManagedSession{
		subscribers: map[*subscriber]struct{}{},
		scrollback:  scrollbackBuffer{limit: 5},
	}

	session.publish([]byte("hello"))
	session.publish([]byte(" world"))

	attachment := session.subscribe(Cursor{})
	replay, events, unsubscribe := attachment.Replay, attachment.Events, attachment.Unsubscribe
	defer unsubscribe()

	if string(replay) != "world" {
		t.Fatalf("replay = %q, want %q", string(replay), "world")
	}

	session.publish([]byte("!"))
	// Delivery is handed to the subscriber's pump, so the chunk arrives
	// shortly rather than immediately.
	chunk, open := receiveChunk(t, events)
	if !open || string(chunk) != "!" {
		t.Fatalf("event chunk = (%q, open=%v), want %q", chunk, open, "!")
	}
}

func TestManagedSessionFinishClosesSubscribers(t *testing.T) {
	session := &ManagedSession{
		subscribers: map[*subscriber]struct{}{},
		scrollback:  scrollbackBuffer{limit: defaultScrollbackLimit},
	}

	attachment := session.subscribe(Cursor{})
	events, unsubscribe := attachment.Events, attachment.Unsubscribe
	defer unsubscribe()

	session.finish()
	if _, ok := <-events; ok {
		t.Fatal("subscriber channel is still open after finish")
	}
}

func TestTerminateWorkspaceOnlyClosesMatchingSessions(t *testing.T) {
	manager := NewManager()
	one := &ManagedSession{manager: manager, workspaceID: "one", paneID: "pane", subscribers: map[*subscriber]struct{}{}}
	two := &ManagedSession{manager: manager, workspaceID: "two", paneID: "pane", subscribers: map[*subscriber]struct{}{}}
	manager.sessions[sessionKey("one", "pane")] = one
	manager.sessions[sessionKey("two", "pane")] = two

	manager.TerminateWorkspace("one")
	if !one.isClosed() {
		t.Fatal("matching session was not closed")
	}
	if two.isClosed() {
		t.Fatal("other workspace session was closed")
	}
}

func TestProcessIDAndCloseHandlerFollowLivePane(t *testing.T) {
	manager := NewManager()
	managed := &ManagedSession{
		manager: manager, workspaceID: "workspace", paneID: "pane",
		session:     &Session{pty: &pidTestPTY{pid: 4242}},
		subscribers: map[*subscriber]struct{}{},
	}
	manager.sessions[sessionKey("workspace", "pane")] = managed
	closed := make(chan string, 1)
	manager.SetCloseHandler(func(workspaceID, paneID string) { closed <- workspaceID + "/" + paneID })
	if pid, ok := manager.ProcessID("workspace", "pane"); !ok || pid != 4242 {
		t.Fatalf("ProcessID = (%d, %v), want (4242, true)", pid, ok)
	}
	managed.finish()
	if _, ok := manager.ProcessID("workspace", "pane"); ok {
		t.Fatal("closed pane still exposes a PID")
	}
	select {
	case got := <-closed:
		if got != "workspace/pane" {
			t.Fatalf("close callback = %q", got)
		}
	default:
		t.Fatal("close callback was not invoked")
	}
}

func TestManagedSessionGatesTaggedMouseInputFromPTYModes(t *testing.T) {
	pty := &writeTestPTY{}
	managed := &ManagedSession{
		session:     &Session{pty: pty},
		subscribers: map[*subscriber]struct{}{},
	}
	mouse := []byte("\x1b[<32;53;17M")

	if n, err := managed.WriteMouse(mouse); err != nil || n != len(mouse) {
		t.Fatalf("disabled WriteMouse = (%d, %v), want (%d, nil)", n, err, len(mouse))
	}
	if pty.Len() != 0 {
		t.Fatalf("disabled mouse input reached PTY: %q", pty.String())
	}

	managed.publish([]byte("\x1b[?10"))
	managed.publish([]byte("02;1006h"))
	if _, err := managed.WriteMouse(mouse); err != nil {
		t.Fatalf("enabled WriteMouse: %v", err)
	}
	if got := pty.String(); got != string(mouse) {
		t.Fatalf("enabled mouse input = %q, want %q", got, mouse)
	}

	managed.publish([]byte("\x1b[?1002"))
	managed.publish([]byte("l"))
	if _, err := managed.WriteMouse(mouse); err != nil {
		t.Fatalf("disabled WriteMouse after reset: %v", err)
	}
	if got := pty.String(); got != string(mouse) {
		t.Fatalf("stale mouse input reached PTY: %q", got)
	}

	keyboard := []byte("echo still works\r")
	if _, err := managed.Write(keyboard); err != nil {
		t.Fatalf("ordinary Write: %v", err)
	}
	if got, want := pty.String(), string(mouse)+string(keyboard); got != want {
		t.Fatalf("PTY input = %q, want %q", got, want)
	}
}

func TestMouseModeTrackerKeepsOtherTrackingModesEnabled(t *testing.T) {
	var tracker mouseModeTracker
	tracker.consume([]byte("\x1b[?1000;1003h"))
	tracker.consume([]byte("\x1b[?1000l"))
	if !tracker.enabled() {
		t.Fatal("disabling one DEC mode disabled another active mouse mode")
	}
	tracker.consume([]byte("\x1b[?1003l"))
	if tracker.enabled() {
		t.Fatal("mouse tracking remained enabled after every tracking mode was reset")
	}
}
