package terminal

import (
	"reflect"
	"testing"
	"time"
)

func readAlerts(attachment *Attachment) []Alert {
	var alerts []Alert
	for {
		alert, ok := attachment.ReadAlert()
		if !ok {
			return alerts
		}
		alerts = append(alerts, alert)
	}
}

func TestAlertsReachPausedBrowsersAndWaitUntilSeen(t *testing.T) {
	s, _ := stateSession(t)
	paused := s.subscribe(Cursor{Protocol: StateProtocol, OutputPaused: true})
	defer paused.Unsubscribe()
	visible := s.subscribe(Cursor{Protocol: StateProtocol})
	defer visible.Unsubscribe()

	s.publish([]byte("\x07\x1b]777;notify;Build;Done\x07\x1b]9;Tests passed\x1b\\"))
	want := []Alert{
		{Type: "terminal-alert", Epoch: "test-shell", ID: 1, Kind: "notification", Title: "Build", Body: "Done"},
		{Type: "terminal-alert", Epoch: "test-shell", ID: 2, Kind: "notification", Body: "Tests passed"},
		{Type: "terminal-alert", Epoch: "test-shell", ID: 3, Kind: "bell"},
	}
	select {
	case <-paused.AlertWake:
	default:
		t.Fatal("a paused browser was not woken")
	}
	if got := readAlerts(paused); !reflect.DeepEqual(got, want) {
		t.Fatalf("paused browser alerts = %+v", got)
	}
	if got := readAlerts(visible); !reflect.DeepEqual(got, want) {
		t.Fatalf("visible browser alerts = %+v", got)
	}
	if got := s.UnseenAlert(); got == nil || got.ID != 2 {
		t.Fatalf("a bell hid the unseen notification: %+v", got)
	}
	s.SeenAlert("other-shell", 3)
	if s.UnseenAlert() == nil {
		t.Fatal("another shell's alert id cleared this one")
	}
	s.SeenAlert("test-shell", 1)
	if s.UnseenAlert() == nil {
		t.Fatal("seeing an older alert cleared a newer one")
	}
	s.SeenAlert("test-shell", 3)
	if got := s.UnseenAlert(); got != nil {
		t.Fatalf("still unseen: %+v", got)
	}
}

func TestAlertsAreRateLimited(t *testing.T) {
	s, _ := stateSession(t)
	attachment := s.subscribe(Cursor{Protocol: StateProtocol})
	defer attachment.Unsubscribe()
	start := time.Now()
	for i := range 3 {
		s.publishRead([]byte("\x07\x07"), start.Add(time.Duration(i)*100*time.Millisecond))
	}
	s.publishRead([]byte("\x07"), start.Add(1100*time.Millisecond))
	if got := readAlerts(attachment); len(got) != 2 {
		t.Fatalf("bells = %+v, want one a second", got)
	}
	for range 8 {
		s.publishRead([]byte("\x1b]9;hi\x07"), start.Add(2*time.Second))
	}
	if got := readAlerts(attachment); len(got) != notificationBurst {
		t.Fatalf("burst = %d notifications", len(got))
	}
	s.publishRead([]byte("\x1b]9;later\x07"), start.Add(3100*time.Millisecond))
	if got := readAlerts(attachment); len(got) != 1 || got[0].Body != "later" {
		t.Fatalf("after a second = %+v", got)
	}
	for range maximumPendingAlerts + 4 {
		s.mu.Lock()
		s.publishAlertLocked(Alert{Kind: "notification", Body: "queued"})
		s.mu.Unlock()
	}
	if got := readAlerts(attachment); len(got) != maximumPendingAlerts {
		t.Fatalf("a browser that is not reading holds %d alerts", len(got))
	}
}

func TestFocusReportsFollowAnyBrowserFocused(t *testing.T) {
	s, pty := stateSession(t)
	first := s.subscribe(Cursor{Protocol: StateProtocol})
	second := s.subscribe(Cursor{Protocol: StateProtocol})
	defer second.Unsubscribe()

	first.SetFocus(true)
	if pty.String() != "" {
		t.Fatalf("reported before the program asked: %q", pty.String())
	}
	s.publish([]byte("\x1b[?1004h"))
	if pty.String() != "\x1b[I" {
		t.Fatalf("enabling the mode reported %q", pty.String())
	}
	second.SetFocus(true)
	first.SetFocus(false)
	if pty.String() != "\x1b[I" {
		t.Fatalf("the pane is still focused in one browser: %q", pty.String())
	}
	second.SetFocus(false)
	first.SetFocus(true)
	if pty.String() != "\x1b[I\x1b[O\x1b[I" {
		t.Fatalf("focus reports = %q", pty.String())
	}
	focusLeaveDelay = 50 * time.Millisecond
	t.Cleanup(func() { focusLeaveDelay = 500 * time.Millisecond })
	first.Unsubscribe()
	replacement := s.subscribe(Cursor{Protocol: StateProtocol})
	replacement.SetFocus(true)
	time.Sleep(150 * time.Millisecond)
	if pty.String() != "\x1b[I\x1b[O\x1b[I" {
		t.Fatalf("a browser replacing its connection lost focus: %q", pty.String())
	}
	replacement.Unsubscribe()
	if pty.String() != "\x1b[I\x1b[O\x1b[I" {
		t.Fatalf("left before the delay: %q", pty.String())
	}
	deadline := time.Now().Add(2 * time.Second)
	for pty.String() != "\x1b[I\x1b[O\x1b[I\x1b[O" && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if pty.String() != "\x1b[I\x1b[O\x1b[I\x1b[O" {
		t.Fatalf("a focused browser leaving = %q", pty.String())
	}
	first.SetFocus(true)
	if pty.String() != "\x1b[I\x1b[O\x1b[I\x1b[O" {
		t.Fatalf("a closed attachment changed focus: %q", pty.String())
	}
}

func TestColorSchemeChangesAreReportedUnderMode2031(t *testing.T) {
	s, pty := stateSession(t)
	s.publish([]byte("\x1b[?996n"))
	if pty.String() != "\x1b[?997;1n" {
		t.Fatalf("dark query = %q", pty.String())
	}
	if err := s.Configure(true); err != nil {
		t.Fatal(err)
	}
	if pty.String() != "\x1b[?997;1n" {
		t.Fatalf("reported without mode 2031: %q", pty.String())
	}
	s.publish([]byte("\x1b[?2031h"))
	if err := s.Configure(false); err != nil {
		t.Fatal(err)
	}
	if err := s.Configure(false); err != nil {
		t.Fatal(err)
	}
	if pty.String() != "\x1b[?997;1n\x1b[?997;1n" {
		t.Fatalf("mode change reports = %q", pty.String())
	}
}
