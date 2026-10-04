package httpapi

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"tessera/internal/store"
	"tessera/internal/terminal"
	"tessera/internal/terminalcore"
)

func TestTerminalResumeCursorReadsDeliveryOptions(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/terminal?protocol=2&core=test&resumeEpoch=shell&resumeSequence=7&resumeOffset=12&outputPaused=1&snapshotIfChanged=1&catchUpReplay=1", nil)
	cursor := terminalResumeCursor(r)
	if cursor.Protocol != terminal.StateProtocol || cursor.Core != "test" || cursor.Epoch != "shell" || cursor.Sequence != 7 || cursor.Offset != 12 || !cursor.OutputPaused || !cursor.SnapshotIfChanged || !cursor.CatchUpReplay {
		t.Fatalf("cursor: %+v", cursor)
	}
	defaultCursor := terminalResumeCursor(httptest.NewRequest(http.MethodGet, "/api/terminal?protocol=2", nil))
	if defaultCursor.OutputPaused || defaultCursor.SnapshotIfChanged || defaultCursor.CatchUpReplay {
		t.Fatal("visible clients were paused by default")
	}
}

type terminalSocketEvent struct {
	kind int
	data []byte
	err  error
}

func terminalTestSocket(t *testing.T, serverURL, query string) (*websocket.Conn, <-chan terminalSocketEvent) {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(serverURL, "http")+"?"+query,
		http.Header{"Origin": []string{serverURL}})
	if err != nil {
		t.Fatal(err)
	}
	events := make(chan terminalSocketEvent, 256)
	done := make(chan struct{})
	t.Cleanup(func() { close(done); conn.Close() })
	go func() {
		defer close(events)
		for {
			kind, data, err := conn.ReadMessage()
			select {
			case events <- terminalSocketEvent{kind, data, err}:
			case <-done:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	return conn, events
}

func nextTerminalSocketEvent(t *testing.T, events <-chan terminalSocketEvent) terminalSocketEvent {
	t.Helper()
	select {
	case event, open := <-events:
		if !open {
			t.Fatal("terminal socket ended without a close event")
		}
		return event
	case <-time.After(15 * time.Second):
		t.Fatal("terminal socket event timed out")
		return terminalSocketEvent{}
	}
}

func requireTerminalPauseAck(t *testing.T, events <-chan terminalSocketEvent) {
	t.Helper()
	event := nextTerminalSocketEvent(t, events)
	var message struct{ Type string }
	if event.err != nil || event.kind != websocket.TextMessage || json.Unmarshal(event.data, &message) != nil || message.Type != "output-paused" {
		t.Fatalf("paused socket carried output or lost acknowledgement: kind=%d data=%q err=%v", event.kind, event.data, event.err)
	}
}

func readTerminalAttachment(t *testing.T, events <-chan terminalSocketEvent) terminalAttachMessage {
	t.Helper()
	event := nextTerminalSocketEvent(t, events)
	var message terminalAttachMessage
	if event.err != nil || event.kind != websocket.TextMessage || json.Unmarshal(event.data, &message) != nil || message.Type != "attach" {
		t.Fatalf("attachment missing: kind=%d data=%q err=%v", event.kind, event.data, event.err)
	}
	var snapshot []byte
	for len(snapshot) < message.SnapshotBytes {
		event := nextTerminalSocketEvent(t, events)
		if event.err != nil || event.kind != websocket.BinaryMessage || len(event.data) < terminal.StateFrameHeader || event.data[0] != terminal.StateSnapshot {
			t.Fatalf("snapshot stream interrupted: kind=%d err=%v", event.kind, event.err)
		}
		if binary.LittleEndian.Uint64(event.data[1:]) != message.Sequence || int64(binary.LittleEndian.Uint64(event.data[9:])) != message.Offset {
			t.Fatal("snapshot cutoff changed during transfer")
		}
		snapshot = append(snapshot, event.data[terminal.StateFrameHeader:]...)
	}
	if message.SnapshotBytes > 0 && (len(snapshot) != message.SnapshotBytes || !bytes.HasPrefix(snapshot, []byte("TSS2"))) {
		t.Fatal("snapshot transfer is incomplete")
	}
	return message
}

func TestHiddenTerminalWebSocketStopsOutputAndKeepsExitLive(t *testing.T) {
	if testing.Short() {
		t.Skip("uses a real local PTY and WebSocket")
	}
	command := "i=0; while [ \"$i\" -lt 2000 ]; do printf 'terminal-output-%s\\n' \"$i\"; i=$((i+1)); done; printf 'NETWORK_%s\\n' 'PAUSE_DONE'\r"
	if runtime.GOOS == "windows" {
		t.Setenv("TESSERA_TERMINAL_SHELL", "powershell.exe -NoLogo -NoProfile")
		command = "$i=0; while($i -lt 2000){ [Console]::WriteLine(\"terminal-output-$i\"); $i++ }; [Console]::WriteLine(('NETWORK_'+'PAUSE_DONE'))\r"
	} else {
		t.Setenv("TESSERA_TERMINAL_SHELL", "/bin/sh")
	}
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "terminal.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	manager := terminal.NewManager()
	t.Cleanup(manager.Close)
	api := &API{Store: st, Terminals: manager}
	server := httptest.NewServer(http.HandlerFunc(api.terminalSession))
	t.Cleanup(server.Close)
	query := "workspaceId=default&paneId=network-test&cols=80&rows=24&protocol=2&core=" + terminalcore.Compatibility
	hidden, hiddenEvents := terminalTestSocket(t, server.URL, query+"&outputPaused=1")
	if err := hidden.WriteJSON(terminalClientMessage{Type: "timing", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := hidden.WriteJSON(terminalClientMessage{Type: "output-coalescing", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := hidden.WriteJSON(terminalClientMessage{Type: "pause-output"}); err != nil {
		t.Fatal(err)
	}
	requireTerminalPauseAck(t, hiddenEvents)
	visible, visibleEvents := terminalTestSocket(t, server.URL, query)
	initial := readTerminalAttachment(t, visibleEvents)
	if err := hidden.WriteMessage(websocket.BinaryMessage, []byte(command)); err != nil {
		t.Fatal(err)
	}
	collectOutput := func(events <-chan terminalSocketEvent) []byte {
		t.Helper()
		var output []byte
		deadline := time.After(15 * time.Second)
		for !bytes.Contains(output, []byte("NETWORK_PAUSE_DONE")) {
			select {
			case event := <-events:
				if event.err != nil {
					t.Fatal(event.err)
				}
				if event.kind == websocket.BinaryMessage {
					for data := event.data; len(data) >= terminal.StateFrameHeader; {
						n := int(binary.LittleEndian.Uint32(data[17:]))
						if n > len(data)-terminal.StateFrameHeader {
							t.Fatal("partial state event")
						}
						if data[0] == terminal.StateOutput {
							output = append(output, data[terminal.StateFrameHeader:terminal.StateFrameHeader+n]...)
						}
						data = data[terminal.StateFrameHeader+n:]
					}
				}
			case <-deadline:
				t.Fatalf("visible client missed completed build; received %d bytes", len(output))
			}
		}
		return output
	}
	output := collectOutput(visibleEvents)
	if err := hidden.WriteJSON(terminalClientMessage{Type: "pause-output"}); err != nil {
		t.Fatal(err)
	}
	requireTerminalPauseAck(t, hiddenEvents)
	resumeQuery := query + "&snapshotIfChanged=1&resumeEpoch=" + initial.Epoch + "&resumeSequence=0&resumeOffset=0"
	revealed, revealedEvents := terminalTestSocket(t, server.URL, resumeQuery)
	resumed := readTerminalAttachment(t, revealedEvents)
	if !resumed.Reset || resumed.SnapshotBytes == 0 || resumed.Sequence <= initial.Sequence || resumed.Offset <= initial.Offset || resumed.Epoch != initial.Epoch {
		t.Fatalf("reveal did not restore current state of the same shell: %+v", resumed)
	}
	// Pause a previously visible connection as well. Events already in flight
	// can precede its acknowledgement, but nothing may follow it.
	if err := visible.WriteJSON(terminalClientMessage{Type: "pause-output"}); err != nil {
		t.Fatal(err)
	}
	for {
		event := nextTerminalSocketEvent(t, visibleEvents)
		if event.err != nil {
			t.Fatal(event.err)
		}
		var message struct{ Type string }
		if event.kind == websocket.TextMessage && json.Unmarshal(event.data, &message) == nil && message.Type == "output-paused" {
			break
		}
	}
	if err := hidden.WriteMessage(websocket.BinaryMessage, []byte(command)); err != nil {
		t.Fatal(err)
	}
	secondOutput := collectOutput(revealedEvents)
	if err := visible.WriteJSON(terminalClientMessage{Type: "pause-output"}); err != nil {
		t.Fatal(err)
	}
	requireTerminalPauseAck(t, visibleEvents)
	if err := hidden.WriteJSON(terminalClientMessage{Type: "pause-output"}); err != nil {
		t.Fatal(err)
	}
	requireTerminalPauseAck(t, hiddenEvents)
	t.Logf("visible output bytes=%d+%d; both paused sockets carried 0 output frames after acknowledgement; reveal snapshot bytes=%d", len(output), len(secondOutput), resumed.SnapshotBytes)
	// Input and shell-exit notices stay connected even though output is paused.
	if err := hidden.WriteMessage(websocket.BinaryMessage, []byte("exit\r")); err != nil {
		t.Fatal(err)
	}
	event := nextTerminalSocketEvent(t, hiddenEvents)
	if !websocket.IsCloseError(event.err, terminalExitedCloseCode) {
		t.Fatalf("paused shell exit missing: kind=%d data=%q err=%v", event.kind, event.data, event.err)
	}
	event = nextTerminalSocketEvent(t, visibleEvents)
	if !websocket.IsCloseError(event.err, terminalExitedCloseCode) {
		t.Fatalf("formerly visible shell exit missing: %v", event.err)
	}
	visible.Close()
	revealed.Close()
}

func TestSmallHiddenGapReplaysOverRealTerminalWebSocket(t *testing.T) {
	if testing.Short() {
		t.Skip("uses a real local PTY and WebSocket")
	}
	seed := "i=0; while [ \"$i\" -lt 500 ]; do printf 'retained-build-%s\\n' \"$i\"; i=$((i+1)); done; printf 'SEED_%s\\n' 'DONE'\r"
	small := "printf 'GAP_%s\\n' 'DONE'\r"
	if runtime.GOOS == "windows" {
		t.Setenv("TESSERA_TERMINAL_SHELL", "powershell.exe -NoLogo -NoProfile")
		seed = "$i=0; while($i -lt 500){ [Console]::WriteLine(\"retained-build-$i\"); $i++ }; [Console]::WriteLine(('SEED_'+'DONE'))\r"
		small = "echo ('GAP_'+'DONE')\r"
	} else {
		t.Setenv("TESSERA_TERMINAL_SHELL", "/bin/sh")
	}
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "terminal.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	manager := terminal.NewManager()
	t.Cleanup(manager.Close)
	api := &API{Store: st, Terminals: manager}
	server := httptest.NewServer(http.HandlerFunc(api.terminalSession))
	t.Cleanup(server.Close)
	query := "workspaceId=default&paneId=small-gap-test&cols=80&rows=24&protocol=2&core=" + terminalcore.Compatibility
	paused, pausedEvents := terminalTestSocket(t, server.URL, query)
	initial := readTerminalAttachment(t, pausedEvents)
	sequence, offset := initial.Sequence, initial.Offset
	var output []byte
	consume := func(event terminalSocketEvent) {
		t.Helper()
		if event.err != nil {
			t.Fatal(event.err)
		}
		if event.kind != websocket.BinaryMessage {
			return
		}
		for data := event.data; len(data) > 0; {
			if len(data) < terminal.StateFrameHeader {
				t.Fatal("partial event header")
			}
			n := int(binary.LittleEndian.Uint32(data[17:]))
			if n > len(data)-terminal.StateFrameHeader || binary.LittleEndian.Uint64(data[1:]) != sequence+1 {
				t.Fatal("event length or sequence gap")
			}
			sequence++
			nextOffset := int64(binary.LittleEndian.Uint64(data[9:]))
			if data[0] == terminal.StateOutput {
				if nextOffset != offset+int64(n) {
					t.Fatal("output offset gap")
				}
				output = append(output, data[terminal.StateFrameHeader:terminal.StateFrameHeader+n]...)
			} else if nextOffset != offset {
				t.Fatal("control event changed byte offset")
			}
			offset = nextOffset
			data = data[terminal.StateFrameHeader+n:]
		}
	}
	if err := paused.WriteMessage(websocket.BinaryMessage, []byte(seed)); err != nil {
		t.Fatal(err)
	}
	for !bytes.Contains(output, []byte("SEED_DONE")) {
		consume(nextTerminalSocketEvent(t, pausedEvents))
	}
	if err := paused.WriteJSON(terminalClientMessage{Type: "pause-output"}); err != nil {
		t.Fatal(err)
	}
	for {
		event := nextTerminalSocketEvent(t, pausedEvents)
		var message struct{ Type string }
		if event.kind == websocket.TextMessage && json.Unmarshal(event.data, &message) == nil && message.Type == "output-paused" {
			break
		}
		consume(event)
	}
	pausedSequence, pausedOffset := sequence, offset
	peer, peerEvents := terminalTestSocket(t, server.URL, query)
	peerState := readTerminalAttachment(t, peerEvents)
	sequence, offset, output = peerState.Sequence, peerState.Offset, nil
	if err := paused.WriteMessage(websocket.BinaryMessage, []byte(small)); err != nil {
		t.Fatal(err)
	}
	for !bytes.Contains(output, []byte("GAP_DONE")) {
		consume(nextTerminalSocketEvent(t, peerEvents))
	}
	// The peer's marker guarantees that the hidden client's gap exists before
	// attaching. A second pause acknowledgement proves it received no output.
	if err := paused.WriteJSON(terminalClientMessage{Type: "pause-output"}); err != nil {
		t.Fatal(err)
	}
	requireTerminalPauseAck(t, pausedEvents)
	resumeQuery := query + "&snapshotIfChanged=1&catchUpReplay=1&resumeEpoch=" + initial.Epoch +
		"&resumeSequence=" + strconv.FormatUint(pausedSequence, 10) + "&resumeOffset=" + strconv.FormatInt(pausedOffset, 10)
	revealed, revealedEvents := terminalTestSocket(t, server.URL, resumeQuery)
	resumed := readTerminalAttachment(t, revealedEvents)
	if resumed.Reset || resumed.SnapshotBytes != 0 || resumed.Sequence != pausedSequence || resumed.Offset != pausedOffset || resumed.Epoch != initial.Epoch {
		t.Fatalf("small gap imported a snapshot or changed its cursor: %+v", resumed)
	}
	sequence, offset, output = resumed.Sequence, resumed.Offset, nil
	for !bytes.Contains(output, []byte("GAP_DONE")) {
		consume(nextTerminalSocketEvent(t, revealedEvents))
	}
	t.Logf("small-gap output bytes=%d; retained snapshot bytes=%d avoided; replay starts at applied sequence=%d and reaches %d; hidden output stayed paused",
		len(output), peerState.SnapshotBytes, pausedSequence, sequence)
	if err := paused.WriteMessage(websocket.BinaryMessage, []byte("exit\r")); err != nil {
		t.Fatal(err)
	}
	if event := nextTerminalSocketEvent(t, pausedEvents); !websocket.IsCloseError(event.err, terminalExitedCloseCode) {
		t.Fatalf("paused shell exit missing: %v", event.err)
	}
	peer.Close()
	revealed.Close()
}
