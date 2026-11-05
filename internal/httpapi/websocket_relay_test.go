package httpapi

import (
	"bytes"
	"errors"
	"io"
	"testing"
	"time"
)

// scriptedReads hands out one chunk per Read, then io.EOF. The second read
// waits for the first message to start, so that one goes out alone, and the
// eighth closes eighth: by then six more reads are waiting behind it.
type scriptedReads struct {
	chunks  [][]byte
	reads   int
	started chan struct{}
	eighth  chan struct{}
}

func (s *scriptedReads) Read(p []byte) (int, error) {
	s.reads++
	if s.reads == 2 {
		<-s.started
	}
	if s.reads == 8 {
		close(s.eighth)
	}
	if len(s.chunks) == 0 {
		return 0, io.EOF
	}
	count := copy(p, s.chunks[0])
	s.chunks = s.chunks[1:]
	return count, nil
}

// relayScripted relays count chunks of size bytes, holding the first message
// until reads have queued up behind it, and returns the stream and messages.
func relayScripted(t *testing.T, count, size int) ([]byte, [][]byte) {
	t.Helper()
	var stream []byte
	src := &scriptedReads{started: make(chan struct{}), eighth: make(chan struct{})}
	for i := range count {
		chunk := bytes.Repeat([]byte{byte(i)}, size)
		src.chunks = append(src.chunks, chunk)
		stream = append(stream, chunk...)
	}
	var messages [][]byte
	err := relayToWebSocket(func(message []byte) error {
		if len(messages) == 0 {
			close(src.started)
			select {
			case <-src.eighth:
			case <-time.After(5 * time.Second):
				t.Error("reads did not queue behind the first message")
			}
		}
		messages = append(messages, append([]byte(nil), message...))
		return nil
	}, src)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("relay returned %v, want the source's io.EOF", err)
	}
	return stream, messages
}

func TestRelayToWebSocketMergesReadsWaitingBehindAMessage(t *testing.T) {
	stream, messages := relayScripted(t, 20, 1000)
	if got := bytes.Join(messages, nil); !bytes.Equal(got, stream) {
		t.Fatalf("relayed %d bytes, want the %d read, in order", len(got), len(stream))
	}
	if len(messages[0]) != 1000 {
		t.Fatalf("first message = %d bytes, want the first read alone", len(messages[0]))
	}
	if len(messages) < 2 || len(messages[1]) < 6*1000 {
		t.Fatalf("second message = %d bytes, want the six or more reads waiting behind the first", len(messages[1]))
	}
	if len(messages) >= 20 {
		t.Fatalf("relayed %d messages for 20 reads, want fewer", len(messages))
	}
}

func TestRelayToWebSocketCapsMergedMessages(t *testing.T) {
	stream, messages := relayScripted(t, 20, relayBufferBytes)
	if got := bytes.Join(messages, nil); !bytes.Equal(got, stream) {
		t.Fatalf("relayed %d bytes, want the %d read, in order", len(got), len(stream))
	}
	merged := false
	for _, message := range messages {
		if len(message) > relayMessageBytes+relayBufferBytes {
			t.Fatalf("message = %d bytes, past the merging limit", len(message))
		}
		merged = merged || len(message) > relayBufferBytes
	}
	if !merged {
		t.Fatal("no reads were merged")
	}
}

func TestRelayToWebSocketStopsWhenTheWebSocketFails(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	go func() { _, _ = writer.Write([]byte("picture")) }()
	result := make(chan error, 1)
	go func() {
		result <- relayToWebSocket(func([]byte) error { return errors.New("browser went away") }, reader)
	}()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("relay returned %v, want nil after a failed write", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("relay kept waiting on the source after the websocket failed")
	}
}
