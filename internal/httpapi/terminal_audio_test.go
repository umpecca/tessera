package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"tessera/internal/store"
	"tessera/internal/terminal"
	"tessera/internal/terminalaudio"
	"tessera/internal/terminalcore"
	"testing"
	"time"
)

func TestTerminalAudioWebSocketLiveWhileHiddenAndNotReplayed(t *testing.T) {
	if testing.Short() {
		t.Skip("uses a real PTY")
	}
	command := "printf '\\033]777;tessera-audio;1;stop;clip\\007'\r"
	if runtime.GOOS == "windows" {
		t.Setenv("TESSERA_TERMINAL_SHELL", "powershell.exe -NoLogo -NoProfile")
		command = "[Console]::Write(([char]27).ToString()+']777;tessera-audio;1;stop;clip'+[char]7)\r"
	} else {
		t.Setenv("TESSERA_TERMINAL_SHELL", "/bin/sh")
	}
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "audio.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	manager := terminal.NewManager()
	defer manager.Close()
	api := &API{Store: st, Terminals: manager}
	server := httptest.NewServer(http.HandlerFunc(api.terminalSession))
	defer server.Close()
	query := "workspaceId=default&paneId=audio-test&cols=80&rows=24&protocol=2&outputPaused=1&core=" + terminalcore.Compatibility
	a, eventsA := terminalTestSocket(t, server.URL, query)
	b, eventsB := terminalTestSocket(t, server.URL, query)
	enable := func(conn *websocket.Conn, events <-chan terminalSocketEvent, value bool) {
		t.Helper()
		if err := conn.WriteJSON(terminalClientMessage{Type: "audio-events", Enabled: value}); err != nil {
			t.Fatal(err)
		}
		event := nextTerminalSocketEvent(t, events)
		var message struct {
			Type    string
			Enabled bool
		}
		if event.err != nil || json.Unmarshal(event.data, &message) != nil || message.Type != "audio-events" || message.Enabled != value {
			t.Fatalf("bad audio subscription ack: %s %v", event.data, event.err)
		}
	}
	enable(a, eventsA, true)
	enable(b, eventsB, true)
	if err := a.WriteMessage(websocket.BinaryMessage, []byte(command)); err != nil {
		t.Fatal(err)
	}
	for _, events := range []<-chan terminalSocketEvent{eventsA, eventsB} {
		event := nextTerminalSocketEvent(t, events)
		var message terminalaudio.Event
		if event.err != nil || event.kind != websocket.TextMessage || json.Unmarshal(event.data, &message) != nil || message.Type != "terminal-audio" || message.Action != "stop" || message.ID != "clip" || message.Epoch == "" {
			t.Fatalf("hidden audio did not arrive: %s %v", event.data, event.err)
		}
	}
	// Reconnecting a listener gets no audio history, even though the terminal
	// owns replayable raw output containing earlier audio escape sequences.
	a.Close()
	resumed, resumedEvents := terminalTestSocket(t, server.URL, query)
	enable(resumed, resumedEvents, true)
	enable(b, eventsB, false)
	if err := resumed.WriteMessage(websocket.BinaryMessage, []byte(command)); err != nil {
		t.Fatal(err)
	}
	event := nextTerminalSocketEvent(t, resumedEvents)
	var message terminalaudio.Event
	if event.err != nil || json.Unmarshal(event.data, &message) != nil || message.ID != "clip" {
		t.Fatal("resumed listener missed new audio")
	}
	// A control acknowledgement acts as a barrier after the emitted request.
	enable(b, eventsB, false)
	select {
	case event := <-eventsB:
		t.Fatalf("disabled/hidden listener received extra output: %s", event.data)
	case <-time.After(50 * time.Millisecond):
	}
	// Stream setup is the only retained live information. A third hidden client
	// joins at packet one, while the first two receive independently ordered data.
	enable(b, eventsB, true)
	sendOSC := func(sequence []byte) {
		t.Helper()
		encoded := base64.StdEncoding.EncodeToString(sequence)
		cmd := "printf '%s' '" + encoded + "' | base64 -d\r"
		if runtime.GOOS == "windows" {
			cmd = "[Console]::Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "')))\r"
		}
		if err := resumed.WriteMessage(websocket.BinaryMessage, []byte(cmd)); err != nil {
			t.Fatal(err)
		}
	}
	readAudio := func(events <-chan terminalSocketEvent) terminalaudio.Event {
		t.Helper()
		next := nextTerminalSocketEvent(t, events)
		var e terminalaudio.Event
		if next.err != nil || next.kind != websocket.TextMessage || json.Unmarshal(next.data, &e) != nil || e.Type != "terminal-audio" {
			t.Fatalf("bad stream delivery %s %v", next.data, next.err)
		}
		return e
	}
	sendOSC(terminalaudio.StreamSequence(terminalaudio.Event{Action: "stream-start", ID: "stream", Token: "token", Channels: 2, BufferMS: 500, PreSkip: 312}))
	for _, events := range []<-chan terminalSocketEvent{resumedEvents, eventsB} {
		if readAudio(events).PreSkip != 312 {
			t.Fatal("missing original setup")
		}
	}
	sendOSC(terminalaudio.StreamSequence(terminalaudio.Event{Action: "stream-data", ID: "stream", Token: "token", Data: "AgD8AA=="}))
	for _, events := range []<-chan terminalSocketEvent{resumedEvents, eventsB} {
		if readAudio(events).Action != "stream-data" {
			t.Fatal("missing packet zero")
		}
	}
	late, eventsLate := terminalTestSocket(t, server.URL, query)
	enable(late, eventsLate, true)
	join := readAudio(eventsLate)
	if join.Action != "stream-start" || join.Sequence != 1 || join.PreSkip != 0 {
		t.Fatalf("bad live join %+v", join)
	}
	sendOSC(terminalaudio.StreamSequence(terminalaudio.Event{Action: "stream-data", ID: "stream", Token: "token", Sequence: 1, Data: "AgD8AA=="}))
	for _, events := range []<-chan terminalSocketEvent{resumedEvents, eventsB, eventsLate} {
		if e := readAudio(events); e.Action != "stream-data" || e.Sequence != 1 {
			t.Fatalf("bad live packet %+v", e)
		}
	}
	sendOSC(terminalaudio.StreamSequence(terminalaudio.Event{Action: "stream-end", ID: "stream", Token: "token", Sequence: 2}))
	for _, events := range []<-chan terminalSocketEvent{resumedEvents, eventsB, eventsLate} {
		if readAudio(events).Action != "stream-end" {
			t.Fatal("missing EOF")
		}
	}
}
