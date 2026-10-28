package rdpsession

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
)

func TestViewFrameMapsModuleEvents(t *testing.T) {
	size := []byte{0xc0, 0x04, 0x80, 0x02}
	for _, tc := range []struct {
		name    string
		kind    uint32
		payload []byte
		want    []byte
		ok      bool
	}{
		{"connected becomes a desktop size", eventConnected, size, append([]byte{ViewDesktopSize}, size...), true},
		{"a desktop size", eventDesktopSize, size, append([]byte{ViewDesktopSize}, size...), true},
		{"a short size is dropped", eventDesktopSize, size[:3], nil, false},
		{"H.264 passes through", eventH264, []byte{1, 2, 3}, []byte{ViewH264, 1, 2, 3}, true},
		{"an image passes through", eventImage, []byte{4}, []byte{ViewImage, 4}, true},
		{"the end passes through", eventEnded, append([]byte{byte(EndConnectionLost)}, "gone"...), append([]byte{ViewEnded, byte(EndConnectionLost)}, "gone"...), true},
		{"logs are not sent", eventLog, []byte("hello"), nil, false},
		{"the cookie event is not sent", eventReconnectCookie, u32(7), nil, false},
		{"the session ID is not sent", eventSessionID, u32(1), nil, false},
	} {
		got, ok := ViewFrame(tc.kind, tc.payload)
		if ok != tc.ok || !bytes.Equal(got, tc.want) {
			t.Errorf("%s: got %v %v, want %v %v", tc.name, got, ok, tc.want, tc.ok)
		}
	}
}

func TestEndsView(t *testing.T) {
	if !EndsView([]byte{ViewEnded, 0}) || !EndsView(DetachedFrame("x")) {
		t.Fatal("an ending frame wasn't recognized")
	}
	if EndsView([]byte{ViewH264, 1}) || EndsView(nil) {
		t.Fatal("a normal frame was taken for an ending")
	}
	if frame := DetachedFrame("taken"); frame[0] != ViewDetached || string(frame[1:]) != "taken" {
		t.Fatalf("DetachedFrame = %v", frame)
	}
}

func TestViewerMessagesReachTheModule(t *testing.T) {
	runner := &scriptRunner{cookie: true}
	s, _ := startedSession(t, runner, 0)
	input := []byte{inputMouseMove, 10, 0, 20, 0, inputKey, 0x1e, 0, 1}
	resize := binary.LittleEndian.AppendUint16(binary.LittleEndian.AppendUint16(nil, 1280), 720)
	scaled := binary.LittleEndian.AppendUint16(binary.LittleEndian.AppendUint16(binary.LittleEndian.AppendUint16(nil, 1920), 1048), 200)
	for _, message := range [][]byte{
		append([]byte{ViewInput}, input...),
		append([]byte{ViewResize}, resize...),
		append([]byte{ViewResize}, scaled...),
		{ViewRefresh},
	} {
		if err := s.HandleViewerMessage(message); err != nil {
			t.Fatalf("%v: %v", message, err)
		}
	}
	eventually(t, "all four messages", func() bool {
		return runner.count(append([]byte{tagInput}, input...)) == 1 &&
			runner.count(append([]byte{tagResize}, resize...)) == 1 &&
			runner.count(append([]byte{tagResize}, scaled...)) == 1 &&
			runner.count([]byte{tagRefresh}) == 1
	})
}

func TestViewerMessagesAreValidated(t *testing.T) {
	runner := &scriptRunner{cookie: true}
	s, _ := startedSession(t, runner, 0)
	bad := binary.LittleEndian.AppendUint16(binary.LittleEndian.AppendUint16(nil, 100), 720)
	huge := append([]byte{ViewInput}, bytes.Repeat([]byte{inputReleaseAll}, recvCapacity)...)
	for _, message := range [][]byte{
		nil,
		{99},
		{ViewInput, inputMouseMove, 1, 0},
		{ViewInput, inputUnicode, 0, 0xd8, 0, 0, 1},
		huge,
		{ViewResize, 1, 0},
		append([]byte{ViewResize}, bad...),
		{ViewResize, 0x00, 0x05, 0xd0, 0x02, 50, 0}, // scale below 100%
		{ViewResize, 0x00, 0x05, 0xd0, 0x02, 200},   // half a scale
		{ViewRefresh, 1},
	} {
		if err := s.HandleViewerMessage(message); !errors.Is(err, ErrViewerMessage) {
			t.Errorf("%v: err = %v, want ErrViewerMessage", message[:min(len(message), 8)], err)
		}
	}
	s.Close()
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if len(runner.received) != 0 {
		t.Fatalf("invalid messages reached the module: %v", runner.received)
	}
}

func TestViewerInputIsDroppedWithoutAnActiveSession(t *testing.T) {
	runner := &scriptRunner{cookie: true}
	s, server := startedSession(t, runner, 0)
	_ = server.next(t).Close()
	waitDone(t, s)
	if err := s.HandleViewerMessage([]byte{ViewRefresh}); err != nil {
		t.Fatalf("input to a lost session = %v, want it dropped quietly", err)
	}
}

// The bytes web/rdp-viewer.test.mjs expects the browser to send; both sides
// assert the same literals, so a change to either one's format fails a test.
func TestHostAcceptsWhatTheBrowserSends(t *testing.T) {
	runner := &scriptRunner{cookie: true}
	s, _ := startedSession(t, runner, 0)
	for _, message := range [][]byte{
		{1, 1, 10, 0, 20, 0, 2, 0, 1, 4, 0x5b, 0xe0, 1, 3, 1, 100, 0}, // mouse move, button, key, wheel
		{2, 0x00, 0x05, 0xd0, 0x02},                                   // resize to 1280x720
		{3},                                                           // refresh
		{1, 6},                                                        // release all
		{1, 5, 0xac, 0x20, 0, 0, 1},                                   // the euro sign typed
	} {
		if err := s.HandleViewerMessage(message); err != nil {
			t.Fatalf("%v: %v", message, err)
		}
	}
	eventually(t, "the browser's messages", func() bool {
		return runner.count([]byte{tagRefresh}) == 1 && runner.count([]byte{tagInput, 6}) == 1
	})
}
