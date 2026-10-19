package terminal

import (
	"testing"
	"time"
)

func TestLongCommandsFinishingUnwatchedBecomeAlerts(t *testing.T) {
	commandNoticeAfter = 80 * time.Millisecond
	t.Cleanup(func() { commandNoticeAfter = 5 * time.Second })
	s, _ := stateSession(t)
	paused := s.subscribe(Cursor{Protocol: StateProtocol, OutputPaused: true})
	defer paused.Unsubscribe()

	s.publish([]byte("\x1b]133;C;cmdline_url=make%20all\x1b\\building"))
	time.Sleep(120 * time.Millisecond)
	s.publish([]byte("done\r\n\x1b]133;D;2\x1b\\"))
	alerts := readAlerts(paused)
	if len(alerts) != 1 {
		t.Fatalf("alerts = %+v", alerts)
	}
	alert := alerts[0]
	if alert.Kind != "command" || alert.Title != "make all" || alert.Status == nil || *alert.Status != 2 || alert.Seconds != 0 || alert.ID != 1 {
		t.Fatalf("alert = %+v", alert)
	}
	if unseen := s.UnseenAlert(); unseen == nil || unseen.Kind != "command" {
		t.Fatalf("a browser connecting later wouldn't hear of it: %+v", unseen)
	}
	s.publish([]byte("\x07"))
	if unseen := s.UnseenAlert(); unseen.Kind != "command" {
		t.Fatalf("a bell hid it: %+v", unseen)
	}
	readAlerts(paused)

	// Quick commands, cancelled prompts and commands finishing in a watched
	// pane say nothing.
	s.publish([]byte("\x1b]133;C\x1b\\\x1b]133;D;0\x1b\\\x1b]133;D;130\x1b\\"))
	watcher := s.subscribe(Cursor{Protocol: StateProtocol})
	defer watcher.Unsubscribe()
	watcher.SetFocus(true)
	s.publish([]byte("\x1b]133;C;cmdline_url=sleep%201\x1b\\"))
	time.Sleep(120 * time.Millisecond)
	s.publish([]byte("\x1b]133;D;0\x1b\\"))
	if alerts := readAlerts(paused); len(alerts) != 0 {
		t.Fatalf("alerts = %+v", alerts)
	}

	// A shell that sends no command line or status still says when.
	watcher.SetFocus(false)
	s.publish([]byte("\x1b]133;C\x1b\\"))
	time.Sleep(120 * time.Millisecond)
	s.publish([]byte("\x1b]133;D\x1b\\"))
	alerts = readAlerts(paused)
	if len(alerts) != 1 || alerts[0].Title != "" || alerts[0].Status != nil {
		t.Fatalf("alerts = %+v", alerts)
	}

	// Older hooks in a startup file mark the command again, without its
	// command line, and end it again.
	s.publish([]byte("\x1b]133;C;cmdline_url=sleep%206\x1b\\\x1b]133;C\x1b\\"))
	time.Sleep(120 * time.Millisecond)
	s.publish([]byte("\x1b]133;D;0\x1b\\\x1b]133;D;0\x1b\\"))
	alerts = readAlerts(paused)
	if len(alerts) != 1 || alerts[0].Title != "sleep 6" || *alerts[0].Status != 0 {
		t.Fatalf("doubled marks = %+v", alerts)
	}
}
