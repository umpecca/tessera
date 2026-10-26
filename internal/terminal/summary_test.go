package terminal

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSummaryFollowsCommandsAlertsAndScreen(t *testing.T) {
	s, _ := stateSession(t)
	s.paneID = "pane-1"
	summary := s.summary(time.Now())
	if summary.MarksPrompts || summary.Running || summary.OutputSecondsAgo != -1 || len(summary.Tail) != 0 || summary.Cols != 80 {
		t.Fatalf("fresh summary = %+v", summary)
	}
	s.publish([]byte("\x1b]133;A\x1b\\$ "))
	if summary = s.summary(time.Now()); !summary.MarksPrompts || summary.Running {
		t.Fatalf("a shell at its first prompt = %+v", summary)
	}

	s.publish([]byte("\x1b]7;file://studio/Users/me/src%20code\x07\x1b]133;C;cmdline_url=make%20all\x1b\\compiling a\r\n\r\ncompiling b\r\n"))
	summary = s.summary(time.Now().Add(3 * time.Second))
	if !summary.MarksPrompts || !summary.Running || summary.Command != "make all" || summary.RunningSeconds != 3 {
		t.Fatalf("running summary = %+v", summary)
	}
	if summary.Directory != "/Users/me/src code" || summary.OutputSecondsAgo != 3 {
		t.Fatalf("directory or output age = %+v", summary)
	}
	if want := []string{"$ compiling a", "compiling b"}; !reflect.DeepEqual(summary.Tail, want) {
		t.Fatalf("tail = %q, want %q", summary.Tail, want)
	}

	s.publish([]byte("\x1b]133;D;2\x1b\\\x1b]9;Build broke\x07"))
	summary = s.summary(time.Now())
	if summary.Running || summary.Command != "" || summary.LastCommand == nil || summary.LastCommand.Line != "make all" || *summary.LastCommand.Status != 2 {
		t.Fatalf("finished summary = %+v", summary)
	}
	if summary.Alert == nil || summary.Alert.Kind != "notification" || summary.Alert.Body != "Build broke" {
		t.Fatalf("alert = %+v", summary.Alert)
	}
	s.SeenAlert(s.epoch, summary.Alert.ID)
	if summary = s.summary(time.Now()); summary.Alert != nil {
		t.Fatalf("seen alert still listed: %+v", summary.Alert)
	}
}

func TestManagerSummariesListOneWorkspace(t *testing.T) {
	m := NewManager()
	a, _ := stateSession(t)
	a.workspaceID, a.paneID = "w1", "b"
	b, _ := stateSession(t)
	b.workspaceID, b.paneID = "w1", "a"
	other, _ := stateSession(t)
	other.workspaceID, other.paneID = "w2", "c"
	closed, _ := stateSession(t)
	closed.workspaceID, closed.paneID = "w1", "d"
	closed.closed.Store(true)
	for _, s := range []*ManagedSession{a, b, other, closed} {
		m.sessions[sessionKey(s.workspaceID, s.paneID)] = s
	}
	var panes []string
	for _, summary := range m.Summaries("w1") {
		panes = append(panes, summary.PaneID)
	}
	if !reflect.DeepEqual(panes, []string{"a", "b"}) {
		t.Fatalf("panes = %q", panes)
	}
}

func TestScreenTailAndDirectoryReports(t *testing.T) {
	long := strings.Repeat("é", summaryRowBytes)
	tail := screenTail([]string{"one", "", "two   ", "   ", long, ""}, 3)
	if len(tail) != 3 || tail[0] != "one" || tail[1] != "two" || len(tail[2]) > summaryRowBytes || !strings.HasPrefix(long, tail[2]) {
		t.Fatalf("tail = %q", tail)
	}
	if got := screenTail(nil, 3); got == nil || len(got) != 0 {
		t.Fatalf("empty tail = %#v", got)
	}
	for report, want := range map[string]string{
		"file://studio/Users/me": "/Users/me",
		"file:///tmp/a%20b":      "/tmp/a b",
		"http://studio/tmp":      "",
		"not a url %zz":          "",
	} {
		if got := directoryFromReport(report); got != want {
			t.Errorf("directoryFromReport(%q) = %q, want %q", report, got, want)
		}
	}
}

func TestSummaryListsRecentCommandsOnce(t *testing.T) {
	s, _ := stateSession(t)
	run := func(line string) {
		s.publish([]byte("\x1b]133;C;cmdline_url=" + strings.ReplaceAll(line, " ", "%20") + "\x1b\\\x1b]133;D;0\x1b\\"))
	}
	run("make")
	run("git status")
	run("make")
	s.publish([]byte("\x1b]133;C\x1b\\\x1b]133;D;0\x1b\\"))
	run(strings.Repeat("x", recentCommandBytes+1))
	run("echo two \\…")
	if got := s.summary(time.Now()).RecentCommands; !reflect.DeepEqual(got, []string{"make", "git status"}) {
		t.Fatalf("recent = %q", got)
	}
	for i := range recentCommandLimit + 5 {
		run(fmt.Sprintf("echo %d", i))
	}
	got := s.summary(time.Now()).RecentCommands
	if len(got) != recentCommandLimit || got[0] != fmt.Sprintf("echo %d", recentCommandLimit+4) {
		t.Fatalf("recent = %q", got)
	}
}
